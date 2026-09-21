import type { AuthorityHandlers } from "@syncmesh/orpc";

import { Temporal } from "@syncmesh/temporal";
import { eq, max } from "drizzle-orm";

import type { Procedures } from "./procedures.js";

import { identifierOf } from "./domain.js";
import { record } from "./history.js";
import { issue, team } from "./tables.js";

/**
 * The server's half of the API: a body for every `.authority()` leaf and nothing else.
 *
 * `satisfies AuthorityHandlers<Procedures>` is the contract. A leaf without a body, a body
 * without a leaf, or an input that drifted from the declaration is a compile error at this
 * literal — not a 404 discovered in production by whoever deployed the client first.
 *
 * This file is never in the device's bundle. What ships there is `procedures/numbering.ts`, the
 * declaration; the code below needs a database that holds every team's issues at once, which is
 * exactly the test for whether something belongs on an authority at all (D10).
 */
export const authorityHandlers = {
  issues: {
    /**
     * Mints the next number for the issue's team, and writes it onto the row.
     *
     * Two properties earn the round trip. **Gapless**: the sequence is `max + 1` over rows the
     * authority holds, and it holds all of them, which no device does. **Idempotent**: an issue
     * that already has a number gets that number back rather than a second one, so a client
     * retrying after a timeout — the ordinary case on the train this was filed from — cannot
     * burn an identifier.
     *
     * The write goes through the mesh like any other, so it is an ordinary event that folds on
     * every device, and the manifest's `patchOnly` rule is what makes it the *only* writer of
     * this column: the authority acts as an admin, and an admin is the one role the rule does
     * not narrow.
     */
    claimNumber: async ({ input, db, errors }) => {
      // `errors` is a bare record of throwers, so a name declared on the procedure is still
      // `| undefined` to the checker; the fallback keeps the tag in the message rather than
      // pretending the thrower was there
      const refuse = (name: "NO_SUCH_ISSUE" | "NO_SUCH_TEAM") =>
        errors[name]?.() ?? new Error(name);
      const [row] = await db.select().from(issue).where(eq(issue.id, input.issueId));
      if (row === undefined) throw refuse("NO_SUCH_ISSUE");
      const [owning] = await db.select().from(team).where(eq(team.id, row.teamId));
      if (owning === undefined) throw refuse("NO_SUCH_TEAM");
      if (row.number !== null)
        return { number: row.number, identifier: identifierOf(owning.key, row.number) };

      /**
       * `max` rather than `ORDER BY number DESC LIMIT 1`, because the two dialects disagree
       * about where a NULL goes.
       *
       * Most issues have no number until somebody asks for one, so the column is full of NULLs —
       * and SQLite sorts them *last* on a descending order while Postgres sorts them *first*. The
       * ordered read therefore answered 40 on a device and `null` on a server, and `(null ?? 0) + 1`
       * is 1: the same handler handing out ENG-41 in one place and a second ENG-1 in the other.
       * `max` ignores NULLs in both, which is the whole reason to say what is wanted rather than
       * how to find it.
       */
      const [highest] = await db
        .select({ number: max(issue.number) })
        .from(issue)
        .where(eq(issue.teamId, row.teamId));
      const number = (highest?.number ?? 0) + 1;
      const now = Temporal.Now.instant();
      await db.update(issue).set({ number }).where(eq(issue.id, input.issueId));
      await record(db, {
        issueId: input.issueId,
        actorId: "authority",
        kind: "numbered",
        to: String(number),
        when: now,
      });
      return { number, identifier: identifierOf(owning.key, number) };
    },
  },
} satisfies AuthorityHandlers<Procedures>;

import type { SQLWrapper } from "drizzle-orm";

import { columns, operationOf, syncOf } from "@syncmesh/drizzle";
import { query } from "@syncmesh/orpc";
import { and, asc, count, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import * as z from "zod";

import { Id, ISSUE_STATUS, IssueStatus, OPEN_STATUS, scoped } from "../domain.js";
import { comment, issue, issueLabel } from "../tables.js";

/**
 * Every read the tracker performs, and the reason each one is a procedure rather than a query a
 * component writes: a screen names `api.issues.board({ teamId })` and never learns that a board
 * is `ORDER BY rank, id` — which matters here more than usual, because that second sort key is
 * load-bearing (see `../rank.ts`) and a component that forgot it would quietly show one device a
 * different order from another.
 *
 * Reads go through `read(table)` rather than the table directly. It compiles the caller's
 * `read` rule into the source, so a guest's list is filtered by the same rules a receiving
 * device enforces, not by a second copy of them written in TypeScript.
 */

/** The sort every ranked list uses. `id` is the tiebreak that makes a rank collision harmless. */
const byRank = (source: { readonly rank: SQLWrapper; readonly id: SQLWrapper }) => [
  asc(source.rank),
  asc(source.id),
];

const statusFilter = z.array(IssueStatus).min(1).optional();

/**
 * The list behind every filtered view: a team's backlog, one person's queue, a project's scope,
 * a label's rollup. One procedure rather than six, because the filters compose in the UI — "my
 * urgent bugs in Q3" is three of them at once — and six procedures could not answer that.
 */
export const list = query
  .input(
    scoped({
      teamId: Id.optional(),
      projectId: Id.optional(),
      assigneeId: Id.optional(),
      status: statusFilter,
      /** Only work in flight: triage, backlog, todo, started. What a person means by "open". */
      openOnly: z.boolean().optional(),
      limit: z.int().min(1).max(500).optional(),
    }),
  )
  .handler(({ input, db, read }) => {
    const source = read(issue);
    const wanted = input.openOnly === true ? OPEN_STATUS : input.status;
    return db
      .select()
      .from(source)
      .where(
        and(
          input.teamId === undefined ? undefined : eq(source.teamId, input.teamId),
          input.projectId === undefined ? undefined : eq(source.projectId, input.projectId),
          input.assigneeId === undefined ? undefined : eq(source.assigneeId, input.assigneeId),
          wanted === undefined ? undefined : inArray(source.status, [...wanted]),
        ),
      )
      .orderBy(...byRank(source))
      .limit(input.limit ?? 200);
  });

/**
 * One team's board, ranked. Deliberately one query for every column rather than one per status:
 * a drag across columns changes `status` and `rank` in the same write, and two subscriptions
 * would show the card in neither column or both for the length of one fold.
 */
export const board = query.input(scoped({ teamId: Id })).handler(({ input, db, read }) => {
  const source = read(issue);
  return db
    .select()
    .from(source)
    .where(and(eq(source.teamId, input.teamId), inArray(source.status, [...OPEN_STATUS])))
    .orderBy(...byRank(source));
});

/**
 * One issue, with where its own write has got to and which operation it belongs to (book ch. 10).
 * Selected here and not on the list, because these two columns make the query re-run when an
 * acknowledgement lands — which is what a detail view wants and what a hundred-row board does not.
 */
export const get = query.input(scoped({ id: Id })).handler(({ input, db, self }) =>
  db
    // `sync` is a column and not a subscription: it arrives with the row it is about, so a badge
    // cannot render a reach that belongs to a different fetch of a different issue
    .select({ ...columns(issue), operation: operationOf(issue), sync: syncOf(self, issue) })
    .from(issue)
    .where(eq(issue.id, input.id)),
);

/**
 * Search, as a tracker's search actually is: a substring of the title or the body, newest first.
 *
 * `LIKE` and not an FTS index, because the index would have to be a synced table for every
 * device to have it, and a synced index is a second copy of the data that can disagree with the
 * first. The device owns its SQLite file; an FTS5 virtual table built locally from the folded
 * rows is the right answer and is a job for the app's own boot, not for the manifest.
 */
export const search = query
  .input(scoped({ text: z.string().min(1).max(200), limit: z.int().min(1).max(100).optional() }))
  .handler(({ input, db, read }) => {
    const source = read(issue);
    const needle = `%${input.text.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return db
      .select()
      .from(source)
      .where(or(like(source.title, needle), like(source.description, needle)))
      .orderBy(desc(source.updatedAt), asc(source.id))
      .limit(input.limit ?? 25);
  });

/** The badge on each board column. A `GROUP BY`, so one subscription covers all six numbers. */
export const counts = query.input(scoped({ teamId: Id })).handler(({ input, db, read }) => {
  const source = read(issue);
  return db
    .select({ status: source.status, total: count() })
    .from(source)
    .where(eq(source.teamId, input.teamId))
    .groupBy(source.status)
    .orderBy(asc(source.status));
});

/**
 * A person's queue across every team — the view the workspace partition exists to make
 * possible. Were a team a partition of its own, this query could not be written: a handle is
 * pinned to one instance, and "everything assigned to me" spans all of them.
 */
export const assigned = query
  .input(scoped({ assigneeId: Id, openOnly: z.boolean().optional() }))
  .handler(({ input, db, read }) => {
    const source = read(issue);
    return db
      .select()
      .from(source)
      .where(
        and(
          eq(source.assigneeId, input.assigneeId),
          input.openOnly === false ? undefined : inArray(source.status, [...OPEN_STATUS]),
        ),
      )
      .orderBy(desc(source.priority), ...byRank(source));
  });

/** The labels on one issue, as the chips a card renders. */
export const labelsOf = query
  .input(scoped({ issueId: Id }))
  .handler(({ input, db }) =>
    db
      .select()
      .from(issueLabel)
      .where(eq(issueLabel.issueId, input.issueId))
      .orderBy(asc(issueLabel.labelId)),
  );

/** How many issues carry each label, for the sidebar. Counted live rather than kept on the label row. */
export const labelTotals = query
  .input(scoped({}))
  .handler(({ db }) =>
    db
      .select({ labelId: issueLabel.labelId, total: count() })
      .from(issueLabel)
      .groupBy(issueLabel.labelId)
      .orderBy(desc(count()), asc(issueLabel.labelId)),
  );

/**
 * The workspace's own heartbeat: how much is open, how much landed, how much is unnumbered and
 * therefore still waiting on an authority. The last one is the number a devtool wants, because
 * it is the only one on this screen that a network outage can move.
 */
export const summary = query.input(scoped({})).handler(({ db, read }) => {
  const source = read(issue);
  return db
    .select({
      total: count(),
      open: count(sql`CASE WHEN ${inArray(source.status, [...OPEN_STATUS])} THEN 1 END`),
      done: count(sql`CASE WHEN ${eq(source.status, ISSUE_STATUS[4])} THEN 1 END`),
      unnumbered: count(sql`CASE WHEN ${source.number} IS NULL THEN 1 END`),
    })
    .from(source);
});

/** One issue's thread, oldest first — the order a conversation is read in. */
export const thread = query.input(scoped({ issueId: Id })).handler(({ input, db, read }) => {
  const source = read(comment);
  return db
    .select()
    .from(source)
    .where(eq(source.issueId, input.issueId))
    .orderBy(asc(source.createdAt), asc(source.id));
});

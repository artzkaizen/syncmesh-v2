import type { Column, SQLWrapper } from "drizzle-orm";

import { columns, operationOf, syncOf } from "@syncmesh/drizzle";
import { query } from "@syncmesh/orpc";
import { and, asc, count, desc, eq, inArray, like, lte, or, sql } from "drizzle-orm";
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
 * The narrowings an issue list takes — and that a count over that list must take with it.
 *
 * **Declared once because the two reads have to agree.** A page and its badge are two queries
 * over one question, and the moment they carry separate copies of the filters they drift: the
 * drift is invisible on the day it is written and shows up later as a header claiming 40 over a
 * list drawing 3. Adding a filter here adds it to both or neither.
 */
const ISSUE_FILTERS = {
  teamId: Id.optional(),
  projectId: Id.optional(),
  assigneeId: Id.optional(),
  /**
   * Who filed it, which is a different question from who is doing it.
   *
   * "Everything I raised" and "everything on my plate" are the two views a person actually wants
   * of themselves, and a tracker that only offers the second cannot answer "what did I ask for
   * that nobody picked up" — the query a person runs before a standup.
   */
  creatorId: Id.optional(),
  status: statusFilter,
  /** Only work in flight: triage, backlog, todo, started. What a person means by "open". */
  openOnly: z.boolean().optional(),
};

/** What {@link issueWhere} reads, as the shape both procedures' inputs satisfy. */
interface IssueFilters {
  readonly teamId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly assigneeId?: string | undefined;
  readonly creatorId?: string | undefined;
  readonly status?: readonly IssueStatus[] | undefined;
  readonly openOnly?: boolean | undefined;
}

/**
 * The `WHERE` behind both, so neither can narrow by something the other does not.
 *
 * The source is structural, like {@link byRank}'s: `read(issue)` hands back the table with the
 * caller's read rule compiled into it — a subquery, not the table — and naming the columns it
 * needs is what lets one predicate serve both procedures without either restating them.
 */
const issueWhere = (
  input: IssueFilters,
  source: {
    readonly teamId: Column;
    readonly projectId: Column;
    readonly assigneeId: Column;
    readonly creatorId: Column;
    readonly status: Column;
  },
) => {
  const wanted = input.openOnly === true ? OPEN_STATUS : input.status;
  return and(
    input.teamId === undefined ? undefined : eq(source.teamId, input.teamId),
    input.projectId === undefined ? undefined : eq(source.projectId, input.projectId),
    input.assigneeId === undefined ? undefined : eq(source.assigneeId, input.assigneeId),
    input.creatorId === undefined ? undefined : eq(source.creatorId, input.creatorId),
    wanted === undefined ? undefined : inArray(source.status, [...wanted]),
  );
};

/**
 * The list behind every filtered view: a team's backlog, one person's queue, a project's scope,
 * a label's rollup. One procedure rather than six, because the filters compose in the UI — "my
 * urgent bugs in Q3" is three of them at once — and six procedures could not answer that.
 *
 * `limit` makes this a **page**, and a page is a fact about the viewport and about nothing else.
 * Nothing on screen may count these rows and call the result a number of issues; {@link counts}
 * is the read that answers that question.
 */
export const list = query
  .input(
    scoped({
      ...ISSUE_FILTERS,
      limit: z.int().min(1).max(500).optional(),
      /**
       * Take the first `perStatus` of **each** status rather than the first `limit` overall.
       *
       * A grouped board cannot page on a flat limit. The rows come back in rank order across
       * every status at once, so the first 500 of 10,000 are whatever the ranks happened to put
       * first — and a column whose issues all rank late draws nothing under a badge reading
       * 3,000. Scrolling would not help: the next 500 are just as arbitrarily distributed.
       *
       * The obvious repair is a query per column, and it is the one thing this must not do:
       * `board` above states why, and the reason applies here word for word — a drag across
       * columns changes `status` and `rank` in one write, and two subscriptions re-reading
       * independently show the card in neither column or in both for the length of a fold.
       *
       * So the window goes **inside** the single statement. `ROW_NUMBER() OVER (PARTITION BY
       * status …)` numbers each status's own rows, and the outer `WHERE` keeps the first N of
       * every one. One statement, one subscription, one atomic re-read — and every column is
       * filled from its own ranking instead of from a shared race.
       */
      perStatus: z.int().min(1).max(200).optional(),
    }),
  )
  .handler(({ input, db, read }) => {
    const source = read(issue);
    const where = issueWhere(input, source);
    if (input.perStatus === undefined)
      return db
        .select()
        .from(source)
        .where(where)
        .orderBy(...byRank(source))
        .limit(input.limit ?? 200);

    const ranked = db
      .select({
        ...columns(issue),
        within:
          sql<number>`row_number() over (partition by ${source.status} order by ${source.rank}, ${source.id})`.as(
            "within",
          ),
      })
      .from(source)
      .where(where)
      .as("ranked");

    // the numbering is scaffolding for the filter below and is dropped rather than selected: it
    // is not a column of `issue`, and a row carrying it would differ in shape from the one the
    // unwindowed branch returns. Taken off the subquery's own fields so the two cannot drift.
    const { within: _numbering, ...projected } = ranked._.selectedFields;

    return db
      .select(projected)
      .from(ranked)
      .where(lte(ranked.within, input.perStatus))
      .orderBy(asc(ranked.rank), asc(ranked.id))
      .limit(input.limit ?? 500);
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
/**
 * The number inside whatever was typed, if there is one.
 *
 * `ENG-42`, `eng 42`, `#42` and `42` are all the same question — "show me issue forty-two" — and
 * it is the question people actually type into a tracker's search box, because the identifier is
 * what they have in front of them in a commit message or a standup. The team prefix is *not*
 * matched against a team: a number is unique per team but people paste the whole identifier, and
 * refusing `ENG-42` because this workspace calls it `ENGINEERING` would be pedantry.
 */
const numberIn = (text: string): number | undefined => {
  const digits = /(?:^|[^0-9])([0-9]{1,9})\s*$/.exec(text.trim());
  if (digits?.[1] === undefined) return undefined;
  const parsed = Number(digits[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export const search = query
  .input(scoped({ text: z.string().min(1).max(200), limit: z.int().min(1).max(100).optional() }))
  .handler(({ input, db, read }) => {
    const source = read(issue);
    const needle = `%${input.text.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const number = numberIn(input.text);
    return (
      db
        .select()
        .from(source)
        .where(
          or(
            like(source.title, needle),
            like(source.description, needle),
            // an exact identifier match rather than a `LIKE` on a number: typing `42` must not
            // return 142, 420 and 4200 above the issue actually asked for
            number === undefined ? undefined : eq(source.number, number),
          ),
        )
        // an exact number match is what was asked for, so it sorts above every text hit
        .orderBy(
          number === undefined ? desc(source.updatedAt) : sql`${source.number} = ${number} desc`,
          desc(source.updatedAt),
          asc(source.id),
        )
        .limit(input.limit ?? 25)
    );
  });

/**
 * The badge on each status header: a `GROUP BY` over {@link list}'s own filters, **with no `LIMIT`**.
 *
 * This exists so that no screen ever counts the rows it is drawing. A list is a page — 500 by
 * rank, or whatever the viewport asked for — and its length is a measurement of that page. A
 * badge is a claim about the data. Deriving the second from the first is the bug that makes a
 * tracker say "50", then "1,240" after a scroll, with nothing on screen to account for the jump;
 * it is also how a status nothing was fetched for sits at 0 forever while rows are written into
 * it. Taking every filter `list` takes is what makes the two numbers about the same question.
 *
 * Exact rather than approximate, because interest is partitions and nothing finer
 * (`engine/interest.ts`): a device holds a whole partition or none of it, so a `COUNT` over what
 * is held is the true count for that scope and cannot grow as somebody scrolls.
 *
 * One subscription covers every status.
 */
export const counts = query.input(scoped(ISSUE_FILTERS)).handler(({ input, db, read }) => {
  const source = read(issue);
  return db
    .select({ status: source.status, total: count() })
    .from(source)
    .where(issueWhere(input, source))
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

/**
 * One issue's thread — **the newest page first**, resuming strictly before a comment already seen.
 *
 * A cursor rather than the window the board uses, because a thread is the other shape: it is
 * unbounded, it is read backwards from the newest, and nobody scrolls a year of conversation to
 * reach today. A window would have to hold every comment since the first one to show the last
 * ten. A cursor holds ten.
 *
 * **Not an `OFFSET`.** An offset addresses a position, and positions shift — here not only when
 * somebody else comments but every time a peer reconnects and folds a run of events above the
 * one being read, which would skip and repeat comments with nothing on screen to explain it. The
 * cursor addresses a *value*, so a comment arriving while somebody reads changes what the next
 * page contains and never what it skips.
 *
 * `(createdAt, id)` as one row-value comparison rather than the `OR` chain it expands to: a
 * single predicate SQLite drives straight off `(issueId, createdAt desc, id desc)`, measured at
 * 0.9 µs for a page four thousand comments deep. The `id` tiebreak is not decoration — two
 * comments can share a millisecond, and without it a page boundary that lands between them drops
 * one forever.
 *
 * Newest-first is the order this pages in, and the reverse of the order it reads in. `Thread`
 * flips it once for display, which is the one place that decision belongs.
 */
export const thread = query
  .input(
    scoped({
      issueId: Id,
      /** Resume strictly before this comment: `{ at, id }` taken from the oldest row drawn. */
      before: z.object({ at: z.int(), id: Id }).optional(),
      limit: z.int().min(1).max(200).optional(),
    }),
  )
  .handler(({ input, db, read }) => {
    const source = read(comment);
    const { before } = input;
    return db
      .select()
      .from(source)
      .where(
        and(
          eq(source.issueId, input.issueId),
          before === undefined
            ? undefined
            : sql`(${source.createdAt}, ${source.id}) < (${before.at}, ${before.id})`,
        ),
      )
      .orderBy(desc(source.createdAt), desc(source.id))
      .limit(input.limit ?? 50);
  });

/** How many comments the thread holds — counted without the cursor, so "earlier" is exact. */
export const threadCount = query.input(scoped({ issueId: Id })).handler(({ input, db, read }) => {
  const source = read(comment);
  return db.select({ total: count() }).from(source).where(eq(source.issueId, input.issueId));
});

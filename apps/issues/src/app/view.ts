import type { Answered } from "@syncmesh/react";

import type { IssueStatus } from "../domain.js";
import type {
  activity,
  comment,
  issue,
  issueLabel,
  label,
  member,
  project,
  team,
} from "../tables.js";

import { ISSUE_STATUS, OPEN_STATUS } from "../domain.js";

/**
 * What the screen does to rows after the mesh has handed them over, with no React in it.
 *
 * Grouping, sorting and the arithmetic behind a drag are the three things in this app most
 * likely to be quietly wrong — a group in the wrong order, a sort that is not stable, a drop that
 * computes the neighbours of the *old* position and moves a card somewhere nobody asked for — and
 * all three are pure functions of an array. Keeping them out of the components is what lets
 * `__tests__/view.test.ts` interrogate them without a DOM, which is the only honest way to check
 * a drag.
 *
 * The row types are Drizzle's own `$inferSelect`, not restated. A column added to a table appears
 * here for free, and a column renamed stops compiling in the component that reads it.
 */

export type IssueRow = typeof issue.$inferSelect;
export type TeamRow = typeof team.$inferSelect;
export type MemberRow = typeof member.$inferSelect;
export type LabelRow = typeof label.$inferSelect;
export type ProjectRow = typeof project.$inferSelect;
export type CommentRow = typeof comment.$inferSelect;
export type ActivityRow = typeof activity.$inferSelect;
export type IssueLabelRow = typeof issueLabel.$inferSelect;

/**
 * What the list is narrowed to. Every field is "no opinion" when null, and they compose — "my
 * urgent bugs in Engineering" is three of them at once, which is why `issues.list` takes them all
 * in one call rather than offering a procedure per view.
 */
export interface Filters {
  readonly teamId: string | null;
  readonly assigneeId: string | null;
  /**
   * Who filed it, which is a different question from who is doing it.
   *
   * "Everything I raised" and "everything on my plate" are the two views a person actually wants
   * of themselves, and a tracker that offers only the second cannot answer "what did I ask for
   * that nobody picked up" — the query somebody runs before a standup. It composes with
   * `assigneeId` rather than replacing it, which is what makes "filed by me, on Bo" one list.
   */
  readonly creatorId: string | null;
  readonly labelId: string | null;
  /** Work in flight only: triage, backlog, todo, started. What a person means by "open". */
  readonly openOnly: boolean;
  readonly text: string;
}

export const NO_FILTERS = {
  teamId: null,
  assigneeId: null,
  creatorId: null,
  labelId: null,
  openOnly: true,
  text: "",
} satisfies Filters;

/**
 * `manual` is first because it is the only one the *workspace* holds an opinion about: it is the
 * `rank` column, dragged into place by a person and synced. The other four are this tab's private
 * preference over the same rows, which is why they are applied here rather than in a procedure.
 */
export const SORTS = ["manual", "priority", "updated", "created", "title"] as const;
export type Sort = (typeof SORTS)[number];

export const SORT_LABEL = {
  manual: "Manual",
  priority: "Priority",
  updated: "Updated",
  created: "Created",
  title: "Title",
} satisfies Record<Sort, string>;

/** A drag only means something against the order a person dragged it in. */
export const isDraggable = (sort: Sort): boolean => sort === "manual";

/**
 * Two opaque keys, in **code-unit order** — never `localeCompare`.
 *
 * `rank` is base 62 chosen so that plain string comparison is the order SQLite's `TEXT` collation
 * gives (`../rank.ts`), and a locale comparator does not agree with it: ICU sorts `iH1` before
 * `ZQ1` and SQLite sorts it after. Using one here would show this tab a different backlog order
 * from the one `issues.board` returns and from the one every other device draws — which is the
 * exact failure `rank.ts` spends three paragraphs avoiding. The same goes for `id`, which is the
 * tiebreak two devices have to agree on.
 */
const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compare = {
  manual: (a: IssueRow, b: IssueRow) => ascending(a.rank, b.rank),
  priority: (a: IssueRow, b: IssueRow) => b.priority - a.priority,
  updated: (a: IssueRow, b: IssueRow) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  created: (a: IssueRow, b: IssueRow) => b.createdAt.getTime() - a.createdAt.getTime(),
  // the one comparator over human text rather than an opaque key, so the reader's locale is the
  // right authority; this sort is a preference held by this tab and is never written down
  title: (a: IssueRow, b: IssueRow) => a.title.localeCompare(b.title),
} satisfies Record<Sort, (a: IssueRow, b: IssueRow) => number>;

/**
 * Sorted, and **stable in the same way on every device**: `id` is the last tiebreak on every
 * comparator, not just the manual one. Two issues with the same priority would otherwise fall
 * back to whatever order SQLite happened to return them in, which is a different order on a
 * device that folded the events in a different sequence — a difference nobody would ever debug.
 */
export const sortIssues = (rows: readonly IssueRow[], sort: Sort): readonly IssueRow[] =>
  [...rows].sort((a, b) => compare[sort](a, b) || ascending(a.id, b.id));

export interface Group {
  readonly status: IssueStatus;
  readonly rows: readonly IssueRow[];
}

/**
 * Which statuses a set of filters can actually produce rows for.
 *
 * `openOnly` is a `WHERE` on the rows (`procedures/reads.ts`), so under it `done` and `canceled`
 * are not empty columns — they are **unreachable** ones. Rendering them anyway is what put two
 * headers on screen that read 0 forever, and worse: {@link Group}s are drop targets, so a card
 * dragged onto "Canceled" was written, filtered out by the very query that drew the board, and
 * vanished with the badge it landed on still reading 0.
 */
export const shownStatuses = (filters: Filters): readonly IssueStatus[] =>
  filters.openOnly ? OPEN_STATUS : ISSUE_STATUS;

/**
 * Grouped the way a board reads, left to right — over the statuses the filters can reach, and
 * **keeping the empty ones among those**. A reachable status with nothing in it is a drop target
 * and a fact ("nothing is in progress"); dropping it would lose a column the moment it emptied,
 * which is exactly when somebody wants to drag the first card into it.
 */
export const groupByStatus = (
  rows: readonly IssueRow[],
  statuses: readonly IssueStatus[] = ISSUE_STATUS,
): readonly Group[] =>
  statuses.map((status) => ({ status, rows: rows.filter((row) => row.status === status) }));

/**
 * A number this screen is allowed to show, beside what it is a number **of**.
 *
 * A bare `number` is the bug. It cannot tell "there are 40" from "40 have arrived so far", and
 * the second rendered as the first is a figure that grows while somebody is reading it — the
 * failure every partially-replicated tracker ships at least once. The cases here are the three
 * honest things a device can say, and the point of the type is that there is no fourth: an
 * unqualified integer cannot reach the screen, because {@link countText} will not produce one.
 *
 * `atLeast` is a **promise**, not an apology. "500+" resolving to "1,240" is a number keeping its
 * word; "50" becoming "1,240" is a number that lied and was corrected.
 *
 * Interest is partitions and nothing finer (`engine/interest.ts`), so a count over held
 * partitions is exact and `exact` is the ordinary case. A mesh that later holds *some* of the
 * partitions a view spans grows a fourth case here — a value beside the partitions missing from
 * it — and it is a new member rather than a reinterpretation of these three.
 */
export type Counted =
  | { readonly kind: "exact"; readonly value: number }
  | { readonly kind: "atLeast"; readonly value: number }
  | { readonly kind: "unknown" };

const EXACT_ZERO: Counted = { kind: "exact", value: 0 };

/** `exact` when the rows behind it were all of them, `atLeast` when they were a page. */
export const counted = (value: number, truncated: boolean): Counted =>
  truncated ? { kind: "atLeast", value } : { kind: "exact", value };

/** What a badge renders. The `+` is not decoration: it is the whole difference the type exists for. */
export const countText = (count: Counted): string =>
  count.kind === "unknown"
    ? "—"
    : `${count.value.toLocaleString()}${count.kind === "atLeast" ? "+" : ""}`;

/** One row of `issues.counts`, as the screen consumes it. */
export interface StatusCount {
  readonly status: string;
  readonly total: number;
}

/**
 * The badge for each rendered status — from the count read when it can answer, from the rows when
 * it cannot.
 *
 * The count read is a `GROUP BY` with no `LIMIT`, so where it applies the answer is exact and
 * stays exact however far the list is scrolled. It does **not** apply to every view: a label
 * filter is tested against the catalog on this device rather than joined in SQL (see
 * {@link taggedWith} and `list.tsx`), and a text search is a different procedure entirely. In
 * both cases the only rows this screen can count are the ones it was handed — so the number is
 * derived from them and marked `atLeast` whenever those rows were a page rather than the set.
 *
 * That fallback is the honest one and not a smaller version of the bug: `atLeast` renders with a
 * `+`, so a figure that may still grow says so before it does.
 */
export function countsFor(
  statuses: readonly IssueStatus[],
  groups: readonly Group[],
  counts: readonly StatusCount[] | undefined,
  truncated: boolean,
): ReadonlyMap<IssueStatus, Counted> {
  const byStatus = new Map<IssueStatus, Counted>();
  const exact = counts === undefined ? undefined : new Map(counts.map((r) => [r.status, r.total]));
  for (const status of statuses) {
    const total = exact?.get(status);
    if (total !== undefined) byStatus.set(status, { kind: "exact", value: total });
    // a status the GROUP BY returned no row for genuinely has none; absent is zero, not unknown
    else if (exact !== undefined) byStatus.set(status, EXACT_ZERO);
    else {
      const rows = groups.find((group) => group.status === status)?.rows.length ?? 0;
      byStatus.set(status, counted(rows, truncated));
    }
  }
  return byStatus;
}

/**
 * How many more of this status exist than are on screen — **exactly**, or `0` when unknowable.
 *
 * This is the question `wasTruncated` used to guess at by comparing a page's length against the
 * limit that produced it, which is ambiguous at exactly the limit and silently wrong if the two
 * constants ever drift. It needs no guess any more: the badge is a `GROUP BY` with no `LIMIT`,
 * the rows are a window over the same filters, and both are exact — so the difference between
 * them is the count of what a window is holding back, and the button that says so never lies.
 *
 * `atLeast` is the label-filter and text-search case, where there is no count read to subtract
 * from. Nothing is claimed there rather than a number guessed.
 */
export const moreIn = (count: Counted, shown: number): number =>
  count.kind === "exact" ? Math.max(0, count.value - shown) : 0;

/** The one number the header strip shows: every rendered badge, added up. */
export const totalOf = (counts: ReadonlyMap<IssueStatus, Counted>): Counted => {
  let value = 0;
  let truncated = false;
  for (const count of counts.values()) {
    if (count.kind === "unknown") return { kind: "unknown" };
    value += count.value;
    truncated ||= count.kind === "atLeast";
  }
  return counted(value, truncated);
};

/** Which issues carry a given label, as the set a filter tests against. */
export const taggedWith = (tags: readonly IssueLabelRow[], labelId: string): ReadonlySet<string> =>
  new Set(tags.filter((tag) => tag.labelId === labelId).map((tag) => tag.issueId));

/** Every label on each issue, keyed by issue, so a hundred rows draw their chips from one read. */
export function labelsByIssue(
  tags: readonly IssueLabelRow[],
): ReadonlyMap<string, readonly string[]> {
  const held = new Map<string, string[]>();
  for (const tag of tags) {
    const current = held.get(tag.issueId);
    if (current === undefined) held.set(tag.issueId, [tag.labelId]);
    else current.push(tag.labelId);
  }
  return held;
}

/** The neighbours `issues.move` wants: what the card lands between, as this device sees the list. */
export interface Drop {
  readonly previousId: string | null;
  readonly nextId: string | null;
}

/**
 * Where a card dropped onto `beforeId` actually lands — `null` meaning the end of the group.
 *
 * The moved card is removed from the order **before** the neighbours are read, and that is the
 * whole subtlety: read as-is, a card dropped onto the row just below it comes back as its own
 * `previousId`. `issues.move` would then compute a key strictly between the rank the card is
 * leaving and the rank beneath it — a move to within a hair of where it already was, which looks
 * to the user like a drag that did nothing. Taking it out first means the two ids either side of
 * the gap are always two *other* rows.
 */
export function dropBetween(
  ordered: readonly string[],
  movedId: string,
  beforeId: string | null,
): Drop {
  const without = ordered.filter((id) => id !== movedId);
  const found = beforeId === null ? -1 : without.indexOf(beforeId);
  const index = found === -1 ? without.length : found;
  return { previousId: without[index - 1] ?? null, nextId: without[index] ?? null };
}

/** Drizzle rows, indexed by their primary key — the lookup every chip and avatar does. */
export const byId = <T extends { readonly id: string }>(
  rows: readonly T[],
): ReadonlyMap<string, T> => new Map(rows.map((row) => [row.id, row]));

/**
 * The detail read's row: the issue's own columns, plus which write this device's copy came from.
 *
 * `issues.get` selects that one extra column and `issues.list` does not, which is the only
 * difference between the two shapes and the reason the panel can open on a list row while it
 * waits for its own read — see {@link panelFor}.
 */
export type SyncReach = "local" | "delivered" | "remote";

export type IssueDetailRow = IssueRow & {
  readonly operation: string | null;
  /** Where this row's own write got to, selected with the row rather than watched beside it. */
  readonly sync: SyncReach | null;
};

/**
 * What the detail panel has to draw, as the situations that are actually distinguishable.
 *
 * Five of the six are ways of *not* having the issue, and they are separate because they are
 * different facts about different things. `waiting` is about this read. `unreadable` is about a
 * read that fell over, which establishes nothing in either direction. `catching-up` is about the
 * other devices — an issue authored on a laptop this phone has not heard from yet is genuinely
 * not here *yet*, and saying so flatly would be as wrong as the opposite. `missing` is a claim
 * about this device's storage, and it is the one that needs the most evidence.
 *
 * `deleted` is the one that is a claim about the **issue** rather than about this device, and it
 * is the only one of the five that is positive knowledge: the row is gone from every query
 * because a tombstone in the replica's own state is hiding it, which is a fact this device holds
 * rather than an absence it is interpreting. It outranks `catching-up` and `missing` for that
 * reason — a device that is still hearing from the mesh already knows this much — and it says
 * nothing about *who* deleted it, because the tombstone names a device and a device is not a
 * person (`Engine.deletedAt`).
 */
export type Panel =
  | { readonly kind: "waiting" }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "catching-up" }
  | { readonly kind: "missing" }
  | { readonly kind: "deleted" }
  | {
      readonly kind: "open";
      readonly row: IssueRow;
      /**
       * Absent until the detail read lands — *cannot say*, never "no operation". The panel opens
       * on the list's row a frame or two before its own read comes back, and the badge that draws
       * this is the one thing on the header that the list could not supply.
       */
      readonly operation: string | null | undefined;
      /** Absent for the same reason `operation` is: the list's row carries neither. */
      readonly sync: SyncReach | null | undefined;
    };

/** What the panel needs of the read it asked for: `useQuery`'s shape, and nothing more. */
export interface PanelRead {
  readonly data: readonly IssueDetailRow[] | undefined;
  readonly answered: Answered;
  readonly error: Error | undefined;
}

/**
 * The panel's state for one issue, from the read asked for it and from the row the list is
 * already drawing.
 *
 * The row is matched against `id` rather than taken as the first of the rows, and that comparison
 * is the whole point of this function. A control in the panel is a write the moment it is touched
 * — the assignee picker commits on `change`, with no save button between the gesture and the
 * ledger — so a panel drawn from a row belonging to some *other* issue is one keystroke away from
 * writing to the wrong one. Matching by id means that panel has no state to draw and cannot be
 * built, rather than being built and then being wrong for a short time.
 *
 * **`listed` is what makes "not on this device" unsayable about a row that is on this device.**
 * It is the rows the list beside this panel is drawing — not a cache and not a copy, the array
 * the screen is rendering — and the id is matched in it here rather than by the caller, for the
 * same reason the read's own rows are. Two live queries over one table
 * re-run at different instants, and the panel's re-runs on acknowledgements as well as on folds,
 * so there are moments when the store answers the panel's question with nothing while the list
 * still holds the row: measured during a leader handover, where the panel went open → "not on
 * this device" → open in 34 ms with the list untouched throughout. A read that disagrees with
 * the rows on screen is not evidence of absence; it is this device failing to answer twice
 * running, and the honest rendering of that is that the panel is still opening.
 *
 * It also used to cover a second cause, and no longer has to. This panel's `issues.get` ran
 * *inside* the rehearsal `useCan` had open on the same handle — three empty-successful reads over
 * two ordinary opens — because a bare `SELECT` joined whatever transaction was on the connection.
 * That was a bug in `@syncmesh/drizzle`'s proxy, not a race between two honest answers, and it is
 * fixed where it belongs: a statement is placed by the sink it came through, so a read beside a
 * rehearsal now waits for it. The cross-check stays for the handover case above, which is a real
 * disagreement between two reads and not a read that was answered out of somebody's staged rows.
 *
 * **`isReady` and not `!isPending`**, because a read that threw is neither pending nor
 * successful, and calling it ready turns a failed read into a confident empty one. That is what
 * `unreadable` is for: the reason is shown rather than swallowed, because a query this device
 * could not run is news.
 */
export const panelFor = (
  id: string,
  found: PanelRead,
  listed: readonly IssueRow[],
  /**
   * Whether this device holds a tombstone for the issue — `Engine.deletedAt`, asked of the mesh
   * and reduced to the one thing a screen may say from it.
   *
   * Defaulted, because a caller that cannot ask has not learned that the issue is *present*: the
   * absence of an answer is not an answer, and the panel falls back to the two sentences it could
   * always say. It is read after the rows and before the read's own state, so a row that a
   * concurrent edit brought back still opens, and an issue this device watched a peer delete says
   * so rather than waiting on a catch-up that will never produce it.
   */
  deleted = false,
): Panel => {
  const row = found.data?.find((candidate) => candidate.id === id);
  if (row !== undefined) return { kind: "open", row, operation: row.operation, sync: row.sync };
  const known = listed.find((candidate) => candidate.id === id);
  if (known !== undefined)
    return { kind: "open", row: known, operation: undefined, sync: undefined };
  if (deleted) return { kind: "deleted" };
  // `answered !== "none"` implies rows, because `"local"` *means* the store handed some back —
  // but the pair is two fields and this is the branch that must not guess, so it checks both
  if (found.answered === "none" || found.data === undefined)
    return found.error === undefined
      ? { kind: "waiting" }
      : { kind: "unreadable", reason: found.error.message };
  // the store has answered and the row is not in it: absent here, or absent everywhere
  return { kind: found.answered === "settled" ? "missing" : "catching-up" };
};

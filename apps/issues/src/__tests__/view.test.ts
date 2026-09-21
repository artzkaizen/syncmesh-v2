import { describe, expect, test } from "bun:test";

import type { IssueDetailRow, IssueRow, PanelRead } from "../app/view.js";

import {
  NO_FILTERS,
  countText,
  countsFor,
  dropBetween,
  groupByStatus,
  isDraggable,
  labelsByIssue,
  panelFor,
  shownStatuses,
  sortIssues,
  taggedWith,
  totalOf,
} from "../app/view.js";
import { ISSUE_STATUS, OPEN_STATUS } from "../domain.js";
import { sequence } from "../rank.js";

/**
 * The three things the screen does to rows once the mesh has handed them over.
 *
 * Worth a test and not a click-through, because all three are wrong in ways a person looking at
 * the app would not notice: a sort that is stable here and unstable on the next device, a column
 * that disappears when it empties, a drag that computes the neighbours of the position the card
 * came *from*. None of them needs a DOM to interrogate, which is exactly why they were kept out
 * of the components.
 */

const ranks = sequence(6);

const rowAt = (index: number, patch: Partial<IssueRow> = {}): IssueRow => ({
  id: `issue-${index}`,
  number: index,
  teamId: "team-eng",
  projectId: null,
  parentId: null,
  title: `title ${index}`,
  description: "",
  status: "todo",
  priority: 0,
  assigneeId: null,
  creatorId: "acct_ada",
  estimate: null,
  dueDate: null,
  rank: ranks[index] ?? "V",
  views: 0,
  createdAt: new Date(1_700_000_000_000 + index),
  updatedAt: new Date(1_700_000_000_000 + index),
  startedAt: null,
  completedAt: null,
  ...patch,
});

describe("sorting", () => {
  test("falls back to the id, so two devices agree on a tie", () => {
    const tied = [rowAt(2, { priority: 3 }), rowAt(0, { priority: 3 }), rowAt(1, { priority: 3 })];
    expect(sortIssues(tied, "priority").map((row) => row.id)).toEqual([
      "issue-0",
      "issue-1",
      "issue-2",
    ]);
    // the same rows in a different arrival order sort to the same list, which is the property
    expect(sortIssues([...tied].reverse(), "priority").map((row) => row.id)).toEqual([
      "issue-0",
      "issue-1",
      "issue-2",
    ]);
  });

  test("manual is the rank column, in SQLite's order and not the locale's", () => {
    const shuffled = [rowAt(3), rowAt(1), rowAt(4), rowAt(0)];
    // `Array.prototype.sort` with no comparator is code-unit order, which is what SQLite's TEXT
    // collation gives and what `rank.ts` builds its keys for; `localeCompare` is not, and would
    // put a lowercase digit before an uppercase one
    expect(sortIssues(shuffled, "manual").map((row) => row.rank)).toEqual(
      shuffled.map((row) => row.rank).sort(),
    );
    expect(isDraggable("manual")).toBe(true);
    expect(isDraggable("priority")).toBe(false);
  });

  test("priority is descending, because urgent belongs at the top", () => {
    const mixed = [rowAt(0, { priority: 1 }), rowAt(1, { priority: 4 }), rowAt(2, { priority: 0 })];
    expect(sortIssues(mixed, "priority").map((row) => row.priority)).toEqual([4, 1, 0]);
  });
});

describe("grouping", () => {
  test("keeps an empty status, because an empty column is still a drop target", () => {
    const groups = groupByStatus([rowAt(0, { status: "started" })]);
    expect(groups.map((group) => group.status)).toEqual([...ISSUE_STATUS]);
    expect(groups.find((group) => group.status === "started")?.rows).toHaveLength(1);
    expect(groups.find((group) => group.status === "backlog")?.rows).toHaveLength(0);
  });
});

/**
 * The badge, which is the number on this screen most able to be quietly wrong.
 *
 * Every case below is one a person looking at the app would read as fine. A column that can never
 * receive a row still draws a header saying 0; a count taken from a page of 500 reads as a count
 * of the issues; a status the `GROUP BY` returned no row for is genuinely empty and not unknown.
 * The type is what makes the difference sayable, so these are the tests that it is being said.
 */
describe("what a badge is allowed to claim", () => {
  test("a status the filters cannot reach is not rendered at all", () => {
    // `openOnly` is a WHERE on the rows: `done` and `canceled` are unreachable, not empty, and a
    // header over an unreachable status is both a lie and a drop target that eats cards
    expect(shownStatuses(NO_FILTERS)).toEqual([...OPEN_STATUS]);
    expect(shownStatuses({ ...NO_FILTERS, openOnly: false })).toEqual([...ISSUE_STATUS]);

    const groups = groupByStatus([rowAt(0, { status: "todo" })], shownStatuses(NO_FILTERS));
    expect(groups.map((group) => group.status)).toEqual([...OPEN_STATUS]);
  });

  test("the count read answers, and the page under it is never counted", () => {
    // one row on screen, 1,240 in the store: the badge is the store's answer, not the page's
    const groups = groupByStatus([rowAt(0, { status: "todo" })], [...OPEN_STATUS]);
    const counts = countsFor(
      [...OPEN_STATUS],
      groups,
      [{ status: "todo", total: 1240 }],
      /* truncated */ true,
    );
    expect(counts.get("todo")).toEqual({ kind: "exact", value: 1240 });
    expect(countText(counts.get("todo") ?? { kind: "unknown" })).toBe("1,240");

    // a status the GROUP BY returned no row for has none — absent is zero, and it is exact
    expect(counts.get("backlog")).toEqual({ kind: "exact", value: 0 });
  });

  test("with no count read, a truncated page says 'at least' rather than a number", () => {
    const groups = groupByStatus([rowAt(0, { status: "todo" })], [...OPEN_STATUS]);
    const capped = countsFor([...OPEN_STATUS], groups, undefined, true);
    expect(capped.get("todo")).toEqual({ kind: "atLeast", value: 1 });
    expect(countText(capped.get("todo") ?? { kind: "unknown" })).toBe("1+");

    // the same rows, known to be all of them, are an exact count and lose the `+`
    const whole = countsFor([...OPEN_STATUS], groups, undefined, false);
    expect(whole.get("todo")).toEqual({ kind: "exact", value: 1 });
    expect(countText(whole.get("todo") ?? { kind: "unknown" })).toBe("1");
  });

  test("a total is only as certain as its least certain part", () => {
    const exact = new Map([
      ["todo", { kind: "exact", value: 3 }],
      ["backlog", { kind: "exact", value: 4 }],
    ] as const);
    expect(totalOf(exact)).toEqual({ kind: "exact", value: 7 });

    // one `atLeast` among them makes the sum a floor, which is the whole point of carrying it
    const mixed = new Map([
      ["todo", { kind: "exact", value: 3 }],
      ["backlog", { kind: "atLeast", value: 500 }],
    ] as const);
    expect(totalOf(mixed)).toEqual({ kind: "atLeast", value: 503 });
    expect(countText(totalOf(mixed))).toBe("503+");
  });
});

describe("a drop", () => {
  const order = ["a", "b", "c", "d"];

  test("names the two rows the card lands between", () => {
    expect(dropBetween(order, "a", "c")).toEqual({ previousId: "b", nextId: "c" });
  });

  test("never names the moved card as its own neighbour", () => {
    // read as-is, "a" dropped on "b" would come back with `previousId: "a"` — and `issues.move`
    // would then compute a key between the rank it is leaving and the rank below it, which is a
    // move to almost exactly where it already was
    const drop = dropBetween(order, "a", "b");
    expect(drop.previousId).not.toBe("a");
    expect(drop).toEqual({ previousId: null, nextId: "b" });
  });

  test("the ends of the list are null, in both directions", () => {
    expect(dropBetween(order, "d", "a")).toEqual({ previousId: null, nextId: "a" });
    expect(dropBetween(order, "a", null)).toEqual({ previousId: "d", nextId: null });
  });

  test("an empty column takes the card with no neighbours at all", () => {
    expect(dropBetween([], "a", null)).toEqual({ previousId: null, nextId: null });
  });

  test("a target that is no longer in the list lands at the end rather than nowhere", () => {
    expect(dropBetween(order, "a", "zzz")).toEqual({ previousId: "d", nextId: null });
  });
});

describe("labels", () => {
  const tags = [
    {
      id: "1",
      issueId: "issue-0",
      labelId: "label-bug",
      addedBy: "acct_ada",
      addedAt: new Date(0),
    },
    {
      id: "2",
      issueId: "issue-0",
      labelId: "label-a11y",
      addedBy: "acct_ada",
      addedAt: new Date(0),
    },
    {
      id: "3",
      issueId: "issue-1",
      labelId: "label-bug",
      addedBy: "acct_ada",
      addedAt: new Date(0),
    },
  ];

  test("indexes by issue, so a hundred rows draw their chips from one read", () => {
    const held = labelsByIssue(tags);
    expect(held.get("issue-0")).toEqual(["label-bug", "label-a11y"]);
    expect(held.get("issue-2")).toBeUndefined();
  });

  test("filters to the issues carrying one label", () => {
    expect([...taggedWith(tags, "label-bug")]).toEqual(["issue-0", "issue-1"]);
    expect(taggedWith(tags, "label-missing").size).toBe(0);
  });
});

/**
 * The gate in front of every control in the detail panel.
 *
 * Worth its own tests because the failure it exists to prevent is invisible while it is
 * happening: the panel draws, the pickers look right, and the one holding another issue's row
 * writes to that issue the moment anything touches it. The assignee picker commits on `change`,
 * and a browser will fire `change` on a focused `<select>` for a typed letter, so "wrong row for
 * a moment" and "wrong issue reassigned" are the same sentence here.
 *
 * **Why the three tests that were here before did not catch a real "not on this device".** They
 * were exhaustive over the two booleans `panelFor` took — and the bug was that two booleans were
 * not enough to ask the question with. `isPending` was set by hand in every case, so the one
 * origin of `isPending: false` that mattered could not be written down: a read that *threw* is
 * neither pending nor successful, and calling it settled turns a failed read into a confident
 * empty one. And `panelFor` had one source of rows, so an empty answer that contradicted the
 * rows on screen — which is what a leader handover produces, and what the user saw — had no way
 * of being expressed at all. Both gaps are inputs, not assertions, which is why passing tests sat
 * over a false sentence for a day.
 */
describe("the detail panel's state", () => {
  const read = (
    rows: readonly IssueDetailRow[] | undefined,
    patch: Partial<PanelRead> = {},
  ): PanelRead => ({
    data: rows,
    isReady: rows !== undefined,
    coverage: { kind: "caught-up" },
    error: undefined,
    ...patch,
  });
  const detail = (index: number): IssueDetailRow => ({
    ...rowAt(index),
    operation: "op-1",
    sync: "local",
  });
  const NONE: readonly IssueRow[] = [];

  test("opens on the row it was named after, and on no other", () => {
    const row = detail(0);
    expect(panelFor("issue-0", read([row]), NONE)).toEqual({
      kind: "open",
      row,
      operation: "op-1",
      sync: "local",
    });
    // the read for issue-1 has not landed and the previous issue's row is all there is: the panel
    // has nothing to draw, rather than drawing issue-0's assignee under issue-1's name
    expect(panelFor("issue-1", read([row]), NONE)).toEqual({ kind: "missing" });
  });

  test("a read still in flight is never reported missing", () => {
    expect(panelFor("issue-0", read(undefined), NONE)).toEqual({ kind: "waiting" });
    // a device with no transport settles before its own first read has come back, so "every
    // source has answered" is not a licence to call an answer that has not arrived an empty one
    expect(panelFor("issue-0", read(undefined, { coverage: { kind: "caught-up" } }), NONE)).toEqual(
      { kind: "waiting" },
    );
  });

  test("a read that fell over says so, rather than reporting the issue absent", () => {
    const failed = read(undefined, { error: new Error("the port closed mid-query") });
    expect(panelFor("issue-0", failed, NONE)).toEqual({
      kind: "unreadable",
      reason: "the port closed mid-query",
    });
  });

  test("a row the list is drawing is never reported missing", () => {
    const listed = rowAt(0);
    // the exact shape of the leader handover: the panel's read re-runs mid-promotion, comes back
    // successful and empty, and the list beside it has not moved. Two disagreeing reads of one
    // table are this device failing to answer, not the issue being gone
    expect(panelFor("issue-0", read([]), [listed])).toEqual({
      kind: "open",
      row: listed,
      operation: undefined,
      sync: undefined,
    });
    // and the same while the read has not answered at all, which is the ordinary click
    expect(panelFor("issue-0", read(undefined), [listed])).toEqual({
      kind: "open",
      row: listed,
      operation: undefined,
      sync: undefined,
    });
    // the list's row is matched by id here, never taken as the first of them
    expect(panelFor("issue-1", read([]), [listed])).toEqual({ kind: "missing" });
  });

  test("the detail read wins over the list's row, because it carries the operation", () => {
    const row = detail(0);
    expect(panelFor("issue-0", read([row]), [rowAt(0)])).toEqual({
      kind: "open",
      row,
      operation: "op-1",
      sync: "local",
    });
  });

  test("absent here and absent everywhere are two sentences", () => {
    expect(panelFor("issue-0", read([]), NONE)).toEqual({ kind: "missing" });
    // an issue authored on a device this one has not heard from is not on this device *yet*
    expect(panelFor("issue-0", read([], { coverage: { kind: "local-only" } }), NONE)).toEqual({
      kind: "catching-up",
    });
  });

  /**
   * The bug a person actually hit: delete on one phone, and the other one — with the panel open —
   * said "not on this device", which is what you say about something you have never heard of.
   *
   * The read is identical in both cases and always will be, because the projection takes the row
   * out of this device's SQLite the moment it stops being visible. The tombstone the kernel keeps
   * for convergence is the only thing that tells them apart, and it reaches here as one boolean.
   */
  test("deleted is not the same absence as never-heard-of", () => {
    expect(panelFor("issue-0", read([]), NONE, true)).toEqual({ kind: "deleted" });
    expect(panelFor("issue-0", read([]), NONE, false)).toEqual({ kind: "missing" });
  });

  test("a delete this device already holds outranks a catch-up that cannot undo it", () => {
    const behind = read([], { coverage: { kind: "local-only" } });
    expect(panelFor("issue-0", behind, NONE, true)).toEqual({ kind: "deleted" });
    // and it is still the honest answer while this panel's own read is in flight
    expect(panelFor("issue-0", read(undefined), NONE, true)).toEqual({ kind: "deleted" });
  });

  test("a row that came back beats the tombstone underneath it", () => {
    const row = detail(0);
    // a concurrent edit stamped above the delete makes the row visible again; the panel opens on
    // it rather than reporting a deletion the replica has already overruled
    expect(panelFor("issue-0", read([row]), NONE, true)).toEqual({
      kind: "open",
      row,
      operation: "op-1",
      sync: "local",
    });
    expect(panelFor("issue-0", read([]), [rowAt(0)], true)).toEqual({
      kind: "open",
      row: rowAt(0),
      operation: undefined,
      sync: undefined,
    });
  });
});

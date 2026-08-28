import { describe, expect, test } from "bun:test";

import type { Op } from "./fixtures.js";

import { compactSetCell, compactSets } from "../compaction.js";
import { joinSets, setTag, setTagsFor, setValue } from "../set.js";
import { getRecord } from "../state.js";
import {
  addTo,
  applyOps,
  bump,
  canonicalState,
  cell,
  column,
  dropFrom,
  hlc,
  insert,
  LIKES,
  MERGE,
  N1,
  NOTES,
  PEER_A,
  PEER_B,
  stamp,
  TAGS,
  update,
} from "./fixtures.js";

const a1 = stamp(1, 0, PEER_A);
const a5 = stamp(5, 0, PEER_A);
const b3 = stamp(3, 0, PEER_B);

/** The set cell one schedule leaves behind; an empty cell if the schedule wrote none. */
const tagsOf = (ops: readonly Op[]) =>
  getRecord(applyOps(ops, MERGE), NOTES, N1)?.cells.get(TAGS) ?? cell({}, a1);

/** One id added and then removed, plus one that is still live — the shape a compaction is for. */
const churned = (): readonly Op[] => {
  const added = setTag(a1, 0);
  return [
    addTo({ tags: { tag: added, value: "draft" } }, a1),
    addTo({ tags: { tag: setTag(b3, 0), value: "urgent" } }, b3),
    dropFrom({ tags: [added] }, a5),
  ];
};

describe("compactSetCell — the bound the set column is missing", () => {
  test("a stable cell drops its tombstones and reads exactly as it did", () => {
    const before = tagsOf(churned());
    expect(Object.keys(before.value ?? {})).toHaveLength(2);
    const after = compactSetCell(before, hlc(5, 0));
    expect(Object.keys(after.value ?? {})).toHaveLength(1);
    expect(setValue(after.value)).toEqual(setValue(before.value));
    expect(after.stamp).toEqual(before.stamp);
  });

  test("a cell written since the frontier keeps every id, and is returned unchanged", () => {
    const before = tagsOf(churned());
    expect(compactSetCell(before, hlc(4, 0))).toBe(before);
  });

  test("compacting twice changes nothing the second time", () => {
    const once = compactSetCell(tagsOf(churned()), hlc(5, 0));
    expect(compactSetCell(once, hlc(5, 0))).toBe(once);
  });

  test("a cell with nothing to drop is returned unchanged, however stable it is", () => {
    const live = tagsOf([addTo({ tags: { tag: setTag(a1, 0), value: "draft" } }, a1)]);
    expect(compactSetCell(live, hlc(99, 0))).toBe(live);
  });
});

describe("the resurrection the whole-cell rule exists to prevent", () => {
  const added = setTag(a1, 0);
  const add = addTo({ tags: { tag: added, value: "draft" } }, a1);
  const drop = dropFrom({ tags: [added] }, a5);

  test("the frontier that would drop this tombstone also guarantees the remove has landed", () => {
    // a peer that has only the add still holds the element live, and its cell stamp (a1) sits
    // above no frontier that reaches the remove (a5) — so it cannot have compacted it away
    const onlyAdded = tagsOf([add]);
    expect(setValue(onlyAdded.value)).toEqual(["draft"]);
    expect(compactSetCell(onlyAdded, hlc(5, 0)).value).toEqual(onlyAdded.value);
  });

  /**
   * The one schedule where the whole-cell rule and a per-entry one give different answers, and so
   * the only one that shows why the entry's own stamp will not do. The frontier sits **above the
   * add and below the remove**: a rule that dropped each tombstone on the stamp its id carries
   * would drop this one, and the peer still holding the add would hand the element straight back
   * at the next merge. Everything else in this file uses a frontier above both writes, where the
   * two rules cannot disagree.
   */
  test("a frontier between the add and the remove drops nothing, so a merge cannot resurrect", () => {
    const onlyAdd = tagsOf([add]); // a peer that has the add and not yet the remove
    const both = tagsOf([add, drop]);
    const frontier = hlc(1, 0); // above a1, below a5

    const compacted = compactSetCell(both, frontier);
    // the element stays gone whichever way the two peers merge — this is the resurrection
    expect(setValue(joinSets(onlyAdd.value, compacted.value))).toEqual([]);
    expect(setValue(joinSets(compacted.value, onlyAdd.value))).toEqual([]);
    // and the cell was written at a5, so the whole-cell rule refused it by identity
    expect(compacted).toBe(both);
  });

  test("a compacted peer merged with one that has not compacted loses nothing", () => {
    const compacted = compactSetCell(tagsOf([add, drop]), hlc(5, 0));
    const uncompacted = tagsOf([add, drop]);
    // the tombstone comes back — compaction is a local reclaim, not a fact anyone else must hold —
    // and the element stays gone in both directions
    expect(setValue(compacted.value)).toEqual([]);
    expect(setValue(uncompacted.value)).toEqual([]);
    expect(setTagsFor(compacted.value, "draft")).toEqual([]);
  });
});

describe("compactSets — two peers, the same events, the same state", () => {
  const ops = [
    insert({ title: "A" }, a1),
    ...churned(),
    bump({ likes: { dec: 0, inc: 2 } }, b3),
    update({ title: "B" }, a5),
  ] satisfies readonly Op[];

  test("peers that folded the same events in opposite orders compact to one state", () => {
    const one = compactSets(applyOps(ops, MERGE), MERGE, hlc(5, 0));
    const other = compactSets(applyOps([...ops].reverse(), MERGE), MERGE, hlc(5, 0));
    expect(canonicalState(other)).toEqual(canonicalState(one));
  });

  test("and hold strictly less than they did, with the same values in them", () => {
    const before = applyOps(ops, MERGE);
    const after = compactSets(before, MERGE, hlc(5, 0));
    const tags = (state: typeof before) => getRecord(state, NOTES, N1)?.cells.get(TAGS)?.value;
    expect(Object.keys(tags(before) ?? {})).toHaveLength(2);
    expect(Object.keys(tags(after) ?? {})).toHaveLength(1);
    expect(setValue(tags(after))).toEqual(setValue(tags(before)));
  });

  test("nothing but a set column is touched: a counter and an lww cell come back identical", () => {
    const before = applyOps(ops, MERGE);
    const after = compactSets(before, MERGE, hlc(5, 0));
    const cells = (state: typeof before) => getRecord(state, NOTES, N1)?.cells;
    expect(cells(after)?.get(LIKES)).toBe(cells(before)?.get(LIKES));
    expect(cells(after)?.get(column("title"))).toBe(cells(before)?.get(column("title")));
  });

  test("a state with nothing to drop comes back by identity, so a caller can skip the write", () => {
    const state = applyOps(ops, MERGE);
    expect(compactSets(state, MERGE, hlc(4, 0))).toBe(state);
    expect(compactSets(state, new Map(), hlc(99, 0))).toBe(state);
  });
});

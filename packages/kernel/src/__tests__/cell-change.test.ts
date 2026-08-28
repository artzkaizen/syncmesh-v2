import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { Op } from "./fixtures.js";

import { counterAdvance, counterValue, type CounterEntry, type CounterState } from "../counter.js";
import { setTag, setTagsFor, setValue, type SetTag } from "../set.js";
import { getRecord, readRow } from "../state.js";
import {
  addTo,
  applyOps,
  bump,
  canonicalState,
  column,
  dropFrom,
  insert,
  LIKES,
  MERGE as merge,
  N1,
  NOTES,
  PEER_A,
  PEER_B,
  remove,
  stamp,
  TAGS,
  update,
} from "./fixtures.js";

const a1 = stamp(1, 0, PEER_A);
const a2 = stamp(2, 0, PEER_A);
const a3 = stamp(3, 0, PEER_A);
const b1 = stamp(1, 0, PEER_B);
const b2 = stamp(2, 0, PEER_B);

const bothOrders = (x: Op, y: Op) => {
  const forward = applyOps([x, y], merge);
  expect(canonicalState(applyOps([y, x], merge))).toEqual(canonicalState(forward));
  return forward;
};

const likes = (ops: readonly Op[]) =>
  counterValue(getRecord(applyOps(ops, merge), NOTES, N1)?.cells.get(LIKES)?.value ?? null);

const tags = (ops: readonly Op[]) =>
  setValue(getRecord(applyOps(ops, merge), NOTES, N1)?.cells.get(TAGS)?.value ?? null);

const own = (peer: typeof PEER_A, by: number, before?: CounterState) => ({
  [LIKES]: counterAdvance(before, peer, by),
});

const ownState = (entry: CounterEntry | undefined): CounterState =>
  entry === undefined ? {} : { [PEER_A]: entry };

describe("increment — the counter column, both delivery orders", () => {
  test("two devices incrementing concurrently both keep their increment", () => {
    const x = bump(own(PEER_A, 1), a1);
    const y = bump(own(PEER_B, 1), b1);
    bothOrders(x, y);
    expect(likes([x, y])).toBe(2);
    expect(likes([y, x])).toBe(2);
  });

  test("a re-delivered increment changes nothing", () => {
    const x = bump(own(PEER_A, 3), a1);
    expect(likes([x, x, x])).toBe(3);
  });

  test("a peer's own later total supersedes its earlier one, whichever arrives first", () => {
    const first = own(PEER_A, 3);
    const second = own(PEER_A, 4, ownState(first[LIKES]));
    expect(likes([bump(first, a1), bump(second, a2)])).toBe(7);
    expect(likes([bump(second, a2), bump(first, a1)])).toBe(7);
  });

  test("decrements are their own monotone half, so +1 then −1 is zero and not a rollback", () => {
    const up = own(PEER_A, 1);
    const down = own(PEER_A, -1, ownState(up[LIKES]));
    expect(likes([bump(up, a1), bump(down, a2)])).toBe(0);
    expect(likes([bump(down, a2), bump(up, a1)])).toBe(0);
  });

  test("a counter shares its row with an lww column and neither disturbs the other", () => {
    const state = applyOps(
      [insert({ title: "A" }, a1), bump(own(PEER_A, 5), a2), update({ title: "B" }, b2)],
      merge,
    );
    expect(readRow(state, NOTES, N1)?.get(column("title"))).toBe("B");
    expect(counterValue(getRecord(state, NOTES, N1)?.cells.get(LIKES)?.value ?? null)).toBe(5);
  });

  test("an increment is a write: it revives a row an earlier delete had hidden", () => {
    expect(readRow(applyOps([insert({ title: "A" }, a1), remove(b2)], merge), NOTES, N1)).toBe(
      undefined,
    );
    const revived = applyOps(
      [insert({ title: "A" }, a1), remove(b2), bump(own(PEER_A, 1), a3)],
      merge,
    );
    expect(readRow(revived, NOTES, N1)).not.toBe(undefined);
  });
});

const addOne = (at: typeof a1, value: string, index = 0) => ({
  tag: setTag(at, index),
  value,
});

describe("add / remove — the OR-Set column, both delivery orders", () => {
  test("an add concurrent with a remove survives, because the remove never saw its id", () => {
    const first = addTo({ [TAGS]: addOne(a1, "urgent") }, a1);
    const seen = setTagsFor(
      getRecord(applyOps([first], merge), NOTES, N1)?.cells.get(TAGS)?.value,
      "urgent",
    );
    const removal = dropFrom({ [TAGS]: seen }, b2);
    const concurrent = addTo({ [TAGS]: addOne(a2, "urgent") }, a2);
    bothOrders(removal, concurrent);
    expect(tags([first, removal, concurrent])).toEqual(["urgent"]);
    expect(tags([concurrent, removal, first])).toEqual(["urgent"]);
  });

  test("a remove that saw every id takes the element out, in either order", () => {
    const one = addTo({ [TAGS]: addOne(a1, "x") }, a1);
    const two = addTo({ [TAGS]: addOne(b1, "x") }, b1);
    const seen = setTagsFor(
      getRecord(applyOps([one, two], merge), NOTES, N1)?.cells.get(TAGS)?.value,
      "x",
    );
    const removal = dropFrom({ [TAGS]: seen }, a3);
    expect(tags([one, two, removal])).toEqual([]);
    expect(tags([removal, two, one])).toEqual([]);
  });

  test("a re-delivered add and a re-delivered remove both change nothing", () => {
    const one = addTo({ [TAGS]: addOne(a1, "x") }, a1);
    const removal = dropFrom({ [TAGS]: [setTag(a1, 0)] }, a2);
    expect(tags([one, removal, one, removal, one])).toEqual([]);
  });

  test("two adds in one transaction are separate ids and both land", () => {
    const both = applyOps(
      [addTo({ [TAGS]: addOne(a1, "x") }, a1), addTo({ [TAGS]: addOne(a1, "y", 1) }, a1)],
      merge,
    );
    expect(setValue(getRecord(both, NOTES, N1)?.cells.get(TAGS)?.value)).toEqual(["x", "y"]);
  });
});

describe("cell changes — properties over a random schedule of every kind in one row", () => {
  const peers = [PEER_A, PEER_B];
  const arbKey = fc.tuple(fc.nat({ max: 30 }), fc.nat({ max: 2 }), fc.nat({ max: 1 }));
  const arbBody = fc.constantFrom("insert", "update", "delete", "increment", "add", "remove");
  const arbSchedule = fc
    .array(fc.tuple(arbBody, fc.integer({ min: -5, max: 5 }), fc.constantFrom("x", "y", "z")), {
      minLength: 1,
      maxLength: 14,
    })
    .chain((bodies) =>
      fc
        .uniqueArray(arbKey, {
          minLength: bodies.length,
          maxLength: bodies.length,
          comparator: (l, r) => l[0] === r[0] && l[1] === r[1] && l[2] === r[2],
        })
        .map((keys) => {
          const running: Record<string, CounterState> = {};
          return bodies.map(([kind, by, element], i): Op => {
            const [ms, logical, p] = keys[i] ?? [0, 0, 0];
            const peer = peers[p] ?? PEER_A;
            const at = stamp(ms, logical, peer);
            if (kind === "insert") return insert({ title: element }, at);
            if (kind === "update") return update({ title: element }, at);
            if (kind === "delete") return remove(at);
            if (kind === "add")
              return addTo({ [TAGS]: { tag: setTag(at, 0), value: element } }, at);
            if (kind === "remove") {
              // Tombstones only ids this schedule has already minted — what a real remover has seen.
              const ids = keys
                .slice(0, i)
                .map(([m, l, q]) => setTag(stamp(m, l, peers[q] ?? PEER_A), 0))
                .filter((_, j) => bodies[j]?.[0] === "add" && bodies[j]?.[2] === element);
              return dropFrom({ [TAGS]: ids satisfies readonly SetTag[] }, at);
            }
            const next = counterAdvance(running[peer], peer, by);
            running[peer] = { [peer]: next };
            return bump({ [LIKES]: next }, at);
          });
        }),
    );

  test("commutative + associative + idempotent: any order, any duplication → one canonical state", () => {
    fc.assert(
      fc.property(arbSchedule, fc.array(fc.nat({ max: 13 }), { maxLength: 14 }), (ops, dupes) => {
        const reference = canonicalState(applyOps(ops, merge));
        expect(canonicalState(applyOps([...ops].reverse(), merge))).toEqual(reference);
        const repeats = dupes.map((i) => ops[i % ops.length]).filter((op) => op !== undefined);
        expect(canonicalState(applyOps([...ops, ...repeats], merge))).toEqual(reference);
      }),
      { numRuns: 2_000 },
    );
  });

  test("a shuffled schedule lands on the same canonical state as the straight one", () => {
    fc.assert(
      fc.property(arbSchedule, fc.array(fc.nat({ max: 13 }), { maxLength: 14 }), (ops, picks) => {
        const shuffled = picks
          .map((i) => i % ops.length)
          .filter((i, at, all) => all.indexOf(i) === at)
          .map((i) => ops[i])
          .filter((op) => op !== undefined);
        const rest = ops.filter((op) => !shuffled.includes(op));
        expect(canonicalState(applyOps([...shuffled, ...rest], merge))).toEqual(
          canonicalState(applyOps(ops, merge)),
        );
      }),
      { numRuns: 1_000 },
    );
  });
});

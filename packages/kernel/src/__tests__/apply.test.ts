import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { MergeSpec } from "../strategy.js";

import { readRow } from "../state.js";
import {
  applyAll,
  column,
  insert,
  N1,
  NOTES,
  PEER_A,
  PEER_B,
  plainState,
  remove,
  row,
  stamp,
  type Stamped,
  update,
} from "./fixtures.js";

const a1 = stamp(1, 0, PEER_A);
const b1 = stamp(1, 0, PEER_B);
const a2 = stamp(2, 0, PEER_A);
const b2 = stamp(2, 0, PEER_B);
const a3 = stamp(3, 0, PEER_A);

const bothOrders = (x: Stamped, y: Stamped, merge?: MergeSpec) => {
  const forward = applyAll([x, y], merge);
  const backward = applyAll([y, x], merge);
  expect(plainState(forward)).toEqual(plainState(backward));
  return forward;
};

describe("applyChange — the collision matrix, both delivery orders", () => {
  test("insert × insert: columns field-merge; the row has the later writeStamp", () => {
    const s = bothOrders(insert({ title: "A", body: "a" }, a1), insert({ title: "B" }, b1));
    expect(readRow(s, NOTES, N1)).toEqual(row({ title: "B", body: "a" }));
  });

  test("insert × update: the patch applies on top", () => {
    const s = bothOrders(insert({ title: "A", body: "a" }, a1), update({ body: "b" }, b2));
    expect(readRow(s, NOTES, N1)).toEqual(row({ title: "A", body: "b" }));
  });

  test("update × update, same column: later stamp wins", () => {
    const s = bothOrders(update({ title: "x" }, a2), update({ title: "y" }, b2));
    expect(readRow(s, NOTES, N1)).toEqual(row({ title: "y" }));
  });

  test("update × update, disjoint columns: both survive", () => {
    const s = bothOrders(update({ title: "x" }, a1), update({ body: "y" }, b1));
    expect(readRow(s, NOTES, N1)).toEqual(row({ title: "x", body: "y" }));
  });

  test("insert × delete: the later stamp decides whether the row lives", () => {
    expect(readRow(bothOrders(insert({ title: "A" }, a1), remove(b2)), NOTES, N1)).toBeUndefined();
    expect(readRow(bothOrders(insert({ title: "A" }, a3), remove(b2)), NOTES, N1)).toEqual(
      row({ title: "A" }),
    );
  });

  test("update × delete: a later delete hides the row, a later update revives it", () => {
    expect(readRow(bothOrders(update({ title: "A" }, a1), remove(b2)), NOTES, N1)).toBeUndefined();
    expect(readRow(bothOrders(update({ title: "A" }, a3), remove(b2)), NOTES, N1)).toEqual(
      row({ title: "A" }),
    );
  });

  test("delete × delete: idempotent, keeps the max stamp", () => {
    const s = bothOrders(remove(a1), remove(b2));
    expect(plainState(s)[NOTES]?.[N1]?.delete).toEqual([2, 0, PEER_B]);
  });

  test("a delete that arrives before any write leaves a tombstone, not a row", () => {
    const s = applyAll([remove(a1)]);
    expect(readRow(s, NOTES, N1)).toBeUndefined();
    expect(plainState(s)[NOTES]?.[N1]?.write).toBeNull();
  });

  test("the input state is never mutated", () => {
    const before = applyAll([insert({ title: "A" }, a1)]);
    const snapshot = plainState(before);
    applyAll([update({ title: "B" }, a2)]);
    bothOrders(update({ title: "C" }, a3), remove(b2));
    expect(plainState(before)).toEqual(snapshot);
  });
});

describe("applyChange — per-column strategies", () => {
  const merge: MergeSpec = new Map([
    [
      NOTES,
      new Map([
        [column("bid"), "max" as const],
        [column("ask"), "min" as const],
      ]),
    ],
  ]);

  test("bid keeps the highest value, ask the lowest, whatever the order", () => {
    const s = bothOrders(update({ bid: 100, ask: 7 }, a1), update({ bid: 90, ask: 5 }, b2), merge);
    expect(readRow(s, NOTES, N1)).toEqual(row({ bid: 100, ask: 5 }));
  });

  test("columns without a strategy stay lww", () => {
    const s = bothOrders(
      update({ bid: 100, note: "old" }, a1),
      update({ bid: 90, note: "new" }, b2),
      merge,
    );
    expect(readRow(s, NOTES, N1)).toEqual(row({ bid: 100, note: "new" }));
  });
});

describe("applyChange — properties", () => {
  const peers = [PEER_A, PEER_B];
  const arbStamped: fc.Arbitrary<Stamped> = fc
    .tuple(
      fc.nat({ max: 50 }),
      fc.nat({ max: 2 }),
      fc.nat({ max: 1 }),
      fc.constantFrom("insert", "update", "delete"),
      fc.dictionary(fc.constantFrom("title", "body", "bid"), fc.nat({ max: 20 }), { maxKeys: 3 }),
    )
    .map(([ms, l, p, kind, values]) => {
      const at = stamp(ms, l, peers[p] ?? PEER_A);
      return kind === "delete"
        ? remove(at)
        : kind === "insert"
          ? insert(values, at)
          : update(values, at);
    });
  const merge: MergeSpec = new Map([[NOTES, new Map([[column("bid"), "max" as const]])]]);

  test("commutative + associative + idempotent: any order, any duplication → one state", () => {
    fc.assert(
      fc.property(
        fc.array(arbStamped, { minLength: 1, maxLength: 12 }),
        fc.array(fc.nat({ max: 11 }), { maxLength: 12 }),
        (changes, dupes) => {
          const shuffled = [...changes].reverse();
          const duplicated = [
            ...changes,
            ...dupes
              .map((i) => changes[i % changes.length])
              .filter((c): c is Stamped => c !== undefined),
          ];
          const reference = plainState(applyAll(changes, merge));
          expect(plainState(applyAll(shuffled, merge))).toEqual(reference);
          expect(plainState(applyAll(duplicated, merge))).toEqual(reference);
        },
      ),
    );
  });

  test("max converges to the maximum under any interleaving", () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 1000 }), { minLength: 1, maxLength: 20 }), (bids) => {
        const changes = bids.map((bid, i) =>
          update({ bid }, stamp(i + 1, 0, i % 2 === 0 ? PEER_A : PEER_B)),
        );
        const s = applyAll([...changes].reverse(), merge);
        expect(readRow(s, NOTES, N1)?.get(column("bid"))).toBe(Math.max(...bids));
      }),
    );
  });
});

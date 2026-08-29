import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { MergeSpec } from "../strategy.js";

import { applyChange, mergeRecord } from "../apply.js";
import { parsePartitionKey } from "../partition.js";
import { getRecord, readRow, readRowsIn } from "../state.js";
import { emptyState } from "../state.js";
import {
  applyAll,
  column,
  insert,
  key,
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

  test("columns without a strategy take the last write", () => {
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
  const arbStampKey = fc.tuple(fc.nat({ max: 50 }), fc.nat({ max: 2 }), fc.nat({ max: 1 }));
  const arbBody = fc.tuple(
    fc.constantFrom("insert", "update", "delete"),
    fc.dictionary(fc.constantFrom("title", "body", "bid"), fc.nat({ max: 20 }), { maxKeys: 3 }),
  );
  // Every change gets a distinct stamp, as every real event does; only replay repeats one.
  const arbChanges = (min: number, max: number): fc.Arbitrary<Stamped[]> =>
    fc.array(arbBody, { minLength: min, maxLength: max }).chain((bodies) =>
      fc
        .uniqueArray(arbStampKey, {
          minLength: bodies.length,
          maxLength: bodies.length,
          comparator: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2],
        })
        .map((keys) =>
          bodies.map(([kind, values], i) => {
            const [ms, l, p] = keys[i] ?? [0, 0, 0];
            const at = stamp(ms, l, peers[p] ?? PEER_A);
            return kind === "delete"
              ? remove(at)
              : kind === "insert"
                ? insert(values, at)
                : update(values, at);
          }),
        ),
    );
  const merge: MergeSpec = new Map([[NOTES, new Map([[column("bid"), "max" as const]])]]);

  test("commutative + associative + idempotent: any order, any duplication → one state", () => {
    fc.assert(
      fc.property(
        arbChanges(1, 12),
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
      { numRuns: 2_000 },
    );
  });

  test("mergeRecord of a folded record equals the fold; merging is idempotent and order-free", () => {
    fc.assert(
      fc.property(arbChanges(2, 16), fc.nat({ max: 15 }), (changes, split) => {
        const cut = 1 + (split % (changes.length - 1));
        const left = changes.slice(0, cut);
        const right = changes.slice(cut);
        const l = getRecord(applyAll(left, merge), NOTES, N1);
        const r = getRecord(applyAll(right, merge), NOTES, N1);
        if (l === undefined || r === undefined) return;
        const folded = plainState(applyAll([...left, ...right], merge));
        const lr = plainState(mergeRecord(applyAll(left, merge), NOTES, N1, r, merge));
        const rl = plainState(mergeRecord(applyAll(right, merge), NOTES, N1, l, merge));
        const twice = plainState(
          mergeRecord(mergeRecord(emptyState(), NOTES, N1, l, merge), NOTES, N1, l, merge),
        );
        expect(lr).toEqual(folded);
        expect(rl).toEqual(folded);
        expect(twice).toEqual(plainState(applyAll(left, merge)));
      }),
      { numRuns: 1_000 },
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

describe("partition on the record", () => {
  test("the first write fixes it; later writes and deletes keep it; unpartitioned writes leave none", () => {
    const acme = parsePartitionKey("org:acme").unwrap();
    const globex = parsePartitionKey("org:globex").unwrap();
    let state = applyChange(emptyState(), insert({ title: "a" }, a1).change, a1, undefined, acme);
    expect(getRecord(state, NOTES, N1)?.partition).toBe(acme);
    state = applyChange(state, update({ title: "b" }, a2).change, a2, undefined, globex);
    expect(getRecord(state, NOTES, N1)?.partition).toBe(acme);
    state = applyChange(state, remove(a3).change, a3);
    expect(getRecord(state, NOTES, N1)?.partition).toBe(acme);
    expect(readRowsIn(state, NOTES, acme).size).toBe(0);

    const plain = applyChange(emptyState(), insert({ title: "a" }, a1).change, a1);
    expect(getRecord(plain, NOTES, N1)).not.toHaveProperty("partition");
  });

  test("readRowsIn lists only the visible rows of one instance", () => {
    const acme = parsePartitionKey("org:acme").unwrap();
    const globex = parsePartitionKey("org:globex").unwrap();
    let state = applyChange(emptyState(), insert({ title: "a" }, a1).change, a1, undefined, acme);
    state = applyChange(
      state,
      { kind: "insert", table: NOTES, key: key("n2"), row: row({ title: "g" }) },
      b1,
      undefined,
      globex,
    );
    state = applyChange(
      state,
      { kind: "insert", table: NOTES, key: key("n3"), row: row({ title: "c" }) },
      b2,
      undefined,
      acme,
    );
    expect([...readRowsIn(state, NOTES, acme).keys()]).toEqual([N1, key("n3")]);
    expect([...readRowsIn(state, NOTES, globex).keys()]).toEqual([key("n2")]);
  });
});

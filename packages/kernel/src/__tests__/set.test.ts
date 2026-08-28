import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { SetState } from "../set.js";

import { canonicalJson, joinSets, readSet, setTag, setTagsFor, setValue } from "../set.js";
import { strategies } from "../strategy.js";
import { cell, PEER_A, PEER_B, stamp, tag } from "./fixtures.js";

const live = (...pairs: readonly (readonly [string, string])[]): SetState =>
  Object.fromEntries(pairs.map(([id, element]) => [id, [element]]));

const gone = (...ids: readonly string[]): SetState => Object.fromEntries(ids.map((id) => [id, []]));

describe("canonicalJson", () => {
  test("object keys sort at every level, so how a value was built never shows", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
});

describe("readSet — a total reader in one normal form", () => {
  test("sorts ids, keeps one element each, and ignores what it cannot read", () => {
    expect(readSet({ t2: ["b"], t1: ["a"], t3: [] })).toEqual({ t1: ["a"], t2: ["b"], t3: [] });
    expect(readSet({ t1: ["a", "b"] })).toEqual(live(["t1", "a"]));
    expect(readSet({ t1: "a" })).toEqual({});
    expect(readSet("nonsense")).toEqual({});
    expect(readSet(undefined)).toEqual({});
  });
});

describe("joinSets — the property that matters", () => {
  test("an add concurrent with a remove survives: the remove never saw its id", () => {
    const before = live(["t1", "x"]);
    const removal = gone(...setTagsFor(before, "x"));
    const concurrent = live(["t2", "x"]);
    expect(setValue(joinSets(joinSets(before, removal), concurrent))).toEqual(["x"]);
    expect(setValue(joinSets(concurrent, joinSets(removal, before)))).toEqual(["x"]);
  });

  test("a remove that saw every id of an element takes it out, in either order", () => {
    const state = joinSets(live(["t1", "x"]), live(["t2", "x"]));
    const removal = gone(...setTagsFor(state, "x"));
    expect(setValue(joinSets(state, removal))).toEqual([]);
    expect(setValue(joinSets(removal, state))).toEqual([]);
  });

  test("a re-delivered add is tombstoned again rather than resurrected", () => {
    const state = live(["t1", "x"]);
    const removed = joinSets(state, gone("t1"));
    expect(setValue(joinSets(removed, state))).toEqual([]);
    expect(joinSets(removed, state)).toEqual(gone("t1"));
  });

  test("one id carrying two elements resolves the same way in both orders", () => {
    expect(joinSets(live(["t1", "b"]), live(["t1", "a"]))).toEqual(
      joinSets(live(["t1", "a"]), live(["t1", "b"])),
    );
    expect(setValue(joinSets(live(["t1", "b"]), live(["t1", "a"])))).toEqual(["a"]);
  });

  test("the strategy keeps the later stamp and joins the value", () => {
    const older = stamp(1, 0, PEER_A);
    const newer = stamp(2, 0, PEER_B);
    const joined = strategies.set(cell(live(["t1", "x"]), older), cell(live(["t2", "y"]), newer));
    expect(joined.stamp).toEqual(newer);
    expect(setValue(joined.value)).toEqual(["x", "y"]);
  });
});

describe("setValue / setTagsFor", () => {
  test("elements come back once each, in id order, whatever added them", () => {
    expect(setValue({ t3: ["b"], t1: ["a"], t2: ["a"], t4: [] })).toEqual(["a", "b"]);
  });

  test("setTagsFor names every id seen for the element, and no tombstone", () => {
    const state = { t1: ["a"], t2: ["a"], t3: ["b"], t4: [] };
    expect(setTagsFor(state, "a")).toEqual([tag("t1"), tag("t2")]);
    expect(setTagsFor(state, "c")).toEqual([]);
  });

  test("an id is unique per peer, per event, per add within the event", () => {
    const at = stamp(7, 2, PEER_A);
    expect(String(setTag(at, 0))).toBe(`7.2.0@${PEER_A}`);
    expect(setTag(at, 1)).not.toBe(setTag(at, 0));
    expect(setTag(stamp(7, 2, PEER_B), 0)).not.toBe(setTag(at, 0));
  });
});

const arbTag = fc.constantFrom("t1", "t2", "t3", "t4");
const arbEntry = fc.oneof(
  fc.constantFrom("a", "b", "c").map((element) => [element]),
  fc.constant([]),
);
const arbState: fc.Arbitrary<SetState> = fc.dictionary(arbTag, arbEntry, { maxKeys: 4 });

describe("joinSets — the lattice laws, at random", () => {
  test("commutative, associative, idempotent", () => {
    fc.assert(
      fc.property(arbState, arbState, arbState, (a, b, c) => {
        expect(joinSets(a, b)).toEqual(joinSets(b, a));
        expect(joinSets(joinSets(a, b), c)).toEqual(joinSets(a, joinSets(b, c)));
        expect(joinSets(a, a)).toEqual(readSet(a));
        expect(joinSets(joinSets(a, b), b)).toEqual(joinSets(a, b));
      }),
      { numRuns: 2_000 },
    );
  });

  test("any order and any duplication of the same adds and removes reach one set", () => {
    fc.assert(
      fc.property(
        fc.array(arbState, { minLength: 1, maxLength: 10 }),
        fc.array(fc.nat({ max: 20 }), { maxLength: 20 }),
        (events, dupes) => {
          const fold = (order: readonly number[]) =>
            order.reduce<SetState>((acc, i) => joinSets(acc, events[i % events.length] ?? {}), {});
          const straight = fold(events.map((_, i) => i));
          expect(fold(events.map((_, i) => events.length - 1 - i))).toEqual(straight);
          expect(fold([...events.map((_, i) => i), ...dupes])).toEqual(straight);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

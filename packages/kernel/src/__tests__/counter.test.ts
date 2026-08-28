import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { CounterEntry, CounterState } from "../counter.js";

import { counterAdvance, counterValue, joinCounters, readCounter } from "../counter.js";
import { strategies } from "../strategy.js";
import { cell, PEER_A, PEER_B, PEER_C, stamp } from "./fixtures.js";

const entry = (inc: number, dec: number): CounterEntry => ({ dec, inc });
const state = (...peers: readonly (readonly [string, CounterEntry])[]) => Object.fromEntries(peers);

describe("readCounter — a total reader, so a bad write is never a disagreement", () => {
  test("keeps well-formed entries and zeroes everything else", () => {
    expect(readCounter({ [PEER_A]: { dec: 1, inc: 4 } })).toEqual(state([PEER_A, entry(4, 1)]));
    expect(readCounter({ [PEER_A]: { inc: -3 } })).toEqual(state([PEER_A, entry(0, 0)]));
    expect(readCounter({ [PEER_A]: { inc: 1.5, dec: "9" } })).toEqual(state([PEER_A, entry(0, 0)]));
    expect(readCounter({ [PEER_A]: 7 })).toEqual({});
    expect(readCounter(null)).toEqual({});
    expect(readCounter("nonsense")).toEqual({});
    expect(readCounter([1, 2])).toEqual({});
    expect(readCounter(undefined)).toEqual({});
  });
});

describe("counterValue", () => {
  test("Σ inc − Σ dec across every peer", () => {
    expect(counterValue({ [PEER_A]: entry(5, 2), [PEER_B]: entry(3, 0) })).toBe(6);
    expect(counterValue({})).toBe(0);
  });
});

describe("counterAdvance — the running total, never the step", () => {
  test("adds to the author's own entry and leaves every other peer alone", () => {
    const current = { [PEER_A]: entry(2, 0), [PEER_B]: entry(9, 9) };
    expect(counterAdvance(current, PEER_A, 3)).toEqual(entry(5, 0));
    expect(counterAdvance(current, PEER_A, -3)).toEqual(entry(2, 3));
    expect(counterAdvance(undefined, PEER_B, 4)).toEqual(entry(4, 0));
  });

  test("a fractional step throws: it would read back as zero and lose the peer's whole history", () => {
    expect(() => counterAdvance(undefined, PEER_A, 0.5)).toThrow("safe integer");
  });
});

describe("joinCounters — per-peer, per-direction max", () => {
  test("two concurrent increments both survive; the same one twice changes nothing", () => {
    const a = { [PEER_A]: entry(1, 0) };
    const b = { [PEER_B]: entry(1, 0) };
    expect(counterValue(joinCounters(a, b))).toBe(2);
    expect(counterValue(joinCounters(joinCounters(a, b), a))).toBe(2);
  });

  test("a stale entry never rolls its peer back", () => {
    const fresh = { [PEER_A]: entry(10, 4) };
    const stale = { [PEER_A]: entry(3, 1) };
    expect(joinCounters(stale, fresh)).toEqual(state([PEER_A, entry(10, 4)]));
    expect(joinCounters(fresh, stale)).toEqual(state([PEER_A, entry(10, 4)]));
  });

  test("the strategy keeps the later stamp and joins the value", () => {
    const older = stamp(1, 0, PEER_A);
    const newer = stamp(2, 0, PEER_B);
    const joined = strategies.counter(
      cell({ [PEER_A]: entry(1, 0) }, older),
      cell({ [PEER_B]: entry(1, 0) }, newer),
    );
    expect(joined.stamp).toEqual(newer);
    expect(counterValue(joined.value)).toBe(2);
  });
});

const arbEntry = fc
  .tuple(fc.nat({ max: 50 }), fc.nat({ max: 50 }))
  .map(([inc, dec]) => entry(inc, dec));
const arbState = fc.dictionary(fc.constantFrom(String(PEER_A), String(PEER_B), "c"), arbEntry, {
  maxKeys: 3,
});

describe("joinCounters — the lattice laws, at random", () => {
  test("commutative, associative, idempotent", () => {
    fc.assert(
      fc.property(arbState, arbState, arbState, (a, b, c) => {
        expect(joinCounters(a, b)).toEqual(joinCounters(b, a));
        expect(joinCounters(joinCounters(a, b), c)).toEqual(joinCounters(a, joinCounters(b, c)));
        expect(joinCounters(a, a)).toEqual(readCounter(a));
        expect(joinCounters(joinCounters(a, b), b)).toEqual(joinCounters(a, b));
      }),
      { numRuns: 2_000 },
    );
  });

  test("any order and any duplication of the same increments reach the sum of the steps", () => {
    const peers = [PEER_A, PEER_B, PEER_C];
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(0, 1, 2), fc.integer({ min: -20, max: 20 })), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.array(fc.nat({ max: 40 }), { maxLength: 20 }),
        (steps, dupes) => {
          // Each device advances its own running totals, exactly as `increment` is authored.
          const own: Record<string, CounterState> = {};
          const events = steps.map(([p, by]) => {
            const peer = peers[p] ?? PEER_A;
            const next = counterAdvance(own[peer], peer, by);
            own[peer] = { [peer]: next };
            return { [peer]: next };
          });
          const fold = (order: readonly number[]) =>
            order.reduce<CounterState>(
              (acc, i) => joinCounters(acc, events[i % events.length] ?? {}),
              {},
            );
          const straight = fold(events.map((_, i) => i));
          const reversed = fold(events.map((_, i) => events.length - 1 - i));
          const noisy = fold([...events.map((_, i) => i), ...dupes]);
          expect(counterValue(straight)).toBe(steps.reduce((sum, [, by]) => sum + by, 0));
          expect(reversed).toEqual(straight);
          expect(noisy).toEqual(straight);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { withEntry } from "../persistent-map.js";

/** The reference: what `withEntry` replaced — a full copy per write. */
const copyWith = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> =>
  new Map(map).set(key, value);

/** One step: write `key = value` onto the `from`-th version held so far, or read one. */
const step = fc.oneof(
  fc.record({
    kind: fc.constant("write" as const),
    from: fc.nat(),
    key: fc.integer({ min: 0, max: 7 }),
    value: fc.integer(),
  }),
  fc.record({ kind: fc.constant("read" as const), from: fc.nat() }),
);

describe("withEntry", () => {
  test("every version reads, sizes and iterates exactly as a copy-per-write Map would", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const real: ReadonlyMap<number, number>[] = [new Map([[100, 0]])];
        const model: ReadonlyMap<number, number>[] = [new Map([[100, 0]])];
        for (const s of steps) {
          const at = s.from % real.length;
          if (s.kind === "write") {
            real.push(withEntry(real[at]!, s.key, s.value));
            model.push(copyWith(model[at]!, s.key, s.value));
          } else {
            expect([...real[at]!]).toEqual([...model[at]!]);
            expect(real[at]!.size).toBe(model[at]!.size);
          }
        }
        real.forEach((version, i) => {
          expect([...version.entries()]).toEqual([...model[i]!.entries()]);
          for (const k of model[i]!.keys()) expect(version.get(k)).toBe(model[i]!.get(k));
          expect(version.has(-1)).toBe(false);
        });
      }),
    );
  });

  test("leaves the input untouched, plain Map or not", () => {
    const plain = new Map([["a", 1]]);
    const first = withEntry(plain, "b", 2);
    const second = withEntry(first, "a", 3);
    expect([...plain]).toEqual([["a", 1]]);
    expect([...first]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect([...second]).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
  });

  test("an iteration paused across writes to other versions still yields its own entries", () => {
    let base: ReadonlyMap<number, string> = new Map();
    for (let i = 0; i < 5; i += 1) base = withEntry(base, i, `v${i}`);
    const seen: [number, string][] = [];
    let other = base;
    for (const entry of base) {
      seen.push(entry);
      // each write reroots the shared map away from `base` mid-walk
      other = withEntry(other, entry[0] + 10, "x");
      other = withEntry(other, entry[0], "overwritten");
    }
    expect(seen).toEqual([0, 1, 2, 3, 4].map((i) => [i, `v${i}`]));
    expect(other.get(0)).toBe("overwritten");
    expect(other.size).toBe(10);
  });

  test("a version thousands of writes old reroots without overflowing the stack", () => {
    const oldest = withEntry(new Map<number, number>(), 0, 0);
    let latest = oldest;
    for (let i = 1; i < 200_000; i += 1) latest = withEntry(latest, i, i);
    expect(oldest.size).toBe(1);
    expect(latest.size).toBe(200_000);
  });
});

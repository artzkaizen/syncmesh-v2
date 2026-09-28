import { describe, expect, test } from "bun:test";

import { FIRST_RANK, between, sequence } from "../rank.js";

describe("fractional ranks — the keys a drag writes", () => {
  test("a key between two keys sorts between them, at every depth", () => {
    let low = FIRST_RANK;
    let high = between(FIRST_RANK, null);
    for (let depth = 0; depth < 60; depth += 1) {
      const middle = between(low, high);
      expect(low < middle).toBe(true);
      expect(middle < high).toBe(true);
      // squeeze towards the lower end, which is the shape repeated "drop just below this" takes
      high = middle;
    }
    expect(low < high).toBe(true);
  });

  test("the ends of the list are `null`, and both directions stay ordered", () => {
    const first = between(null, null);
    const above = between(null, first);
    const below = between(first, null);
    expect([above, first, below].toSorted()).toEqual([above, first, below]);
  });

  test("a seeded sequence is ascending, short, and has room left between every pair", () => {
    const keys = sequence(120);
    expect(keys.toSorted()).toEqual([...keys]);
    expect(new Set(keys).size).toBe(120);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(3);
    for (let index = 1; index < keys.length; index += 1) {
      const low = keys[index - 1] ?? "";
      const high = keys[index] ?? "";
      const wedged = between(low, high);
      expect(low < wedged && wedged < high).toBe(true);
    }
  });

  test("two devices dropping into the same gap get different keys, almost always", () => {
    const drawn = new Set(Array.from({ length: 200 }, () => between("V1", "V2")));
    // the jitter is what buys this; the `(rank, id)` tiebreak is what covers the remainder
    expect(drawn.size).toBeGreaterThan(150);
  });

  test("neighbours handed over in the wrong order are a bug, and say so", () => {
    expect(() => between("V2", "V1")).toThrow(/not below/);
  });
});

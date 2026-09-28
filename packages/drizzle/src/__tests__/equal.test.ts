import { describe, expect, test } from "bun:test";

import { replaceEqualDeep } from "../equal.js";

describe("replaceEqualDeep", () => {
  test("a deeply equal result comes back as the previous reference, so nothing re-renders", () => {
    const previous = [
      { id: "a", title: "Dune" },
      { id: "b", title: "Ubik" },
    ];
    const fresh = [
      { id: "a", title: "Dune" },
      { id: "b", title: "Ubik" },
    ];
    expect(replaceEqualDeep(previous, fresh)).toBe(previous);
  });

  test("one changed row keeps every other row's identity", () => {
    const previous = [
      { id: "a", title: "Dune" },
      { id: "b", title: "Ubik" },
    ];
    const fresh = [
      { id: "a", title: "Dune" },
      { id: "b", title: "VALIS" },
    ];
    const merged = replaceEqualDeep(previous, fresh);

    expect(merged).not.toBe(previous);
    expect(merged[0]).toBe(previous[0]); // untouched row: same object, so a memoised row survives
    expect(merged[1]).toEqual({ id: "b", title: "VALIS" });
    expect(merged[1]).not.toBe(previous[1]);
  });

  test("a bigint compares instead of throwing — JSON.stringify could not", () => {
    const big = 9_007_199_254_740_993n; // past 2^53: what SQLite hands back for a large INTEGER
    expect(() => JSON.stringify([{ n: big }])).toThrow();

    const previous = [{ id: "a", n: big }];
    expect(replaceEqualDeep(previous, [{ id: "a", n: big }])).toBe(previous);
    expect(replaceEqualDeep(previous, [{ id: "a", n: big + 1n }])).not.toBe(previous);
  });

  test("blob columns compare by content, not by identity", () => {
    const previous = [{ id: "a", bytes: new Uint8Array([1, 2, 3]) }];
    const same = [{ id: "a", bytes: new Uint8Array([1, 2, 3]) }];
    const different = [{ id: "a", bytes: new Uint8Array([1, 2, 4]) }];

    expect(replaceEqualDeep(previous, same)).toBe(previous);
    expect(replaceEqualDeep(previous, different)).not.toBe(previous);
  });

  test("a row leaving, a row arriving and a dropped column are all changes", () => {
    const previous = [{ id: "a" }, { id: "b" }];
    expect(replaceEqualDeep(previous, [{ id: "a" }])).not.toBe(previous);
    expect(replaceEqualDeep(previous, [{ id: "a" }, { id: "b" }, { id: "c" }])).not.toBe(previous);
    expect(replaceEqualDeep([{ id: "a", t: 1 }], [{ id: "a" }])).toEqual([{ id: "a" }]);
  });
});

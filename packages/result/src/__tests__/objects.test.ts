import { describe, expect, test } from "bun:test";

import { omitUndefined } from "../objects.js";

describe("omitUndefined", () => {
  test("drops undefined keys and keeps the rest by reference", () => {
    const kept = { nested: true };
    const out = omitUndefined({ a: 1, b: undefined, c: kept });
    expect(out).toEqual({ a: 1, c: kept });
    expect(out.c).toBe(kept);
    expect("b" in out).toBe(false);
  });

  test("empty in, empty out", () => {
    expect(omitUndefined({})).toEqual({});
    expect(omitUndefined({ a: undefined })).toEqual({});
  });
});

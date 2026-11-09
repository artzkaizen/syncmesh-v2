import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { codePointOrder } from "../primitives.js";

const utf8 = new TextEncoder();

/** The order of the strings' UTF-8 bytes: what Rust's `str` order is. */
const byteOrder = (a: string, b: string): number => {
  const left = utf8.encode(a);
  const right = utf8.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return Math.sign(left.length - right.length);
};

describe("codePointOrder", () => {
  test("puts a character above U+FFFF after one in U+E000–U+FFFF, as UTF-8 bytes do", () => {
    expect(["\u{1F600}", "＀"].sort(codePointOrder)).toEqual(["＀", "\u{1F600}"]);
  });

  test("a prefix sorts first, and equal strings are equal", () => {
    expect(codePointOrder("id", "idx")).toBe(-1);
    expect(codePointOrder("idx", "id")).toBe(1);
    expect(codePointOrder("body", "body")).toBe(0);
  });

  test("is the order of the strings' UTF-8 bytes", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), fc.string({ unit: "grapheme" }), (a, b) => {
        expect(byteOrder(a, b)).toBe(codePointOrder(a, b));
      }),
    );
  });
});

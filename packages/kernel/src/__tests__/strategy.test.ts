import { describe, expect, test } from "bun:test";

import { compareValue, strategies } from "../strategy.js";
import { cell, PEER_A, PEER_B, stamp } from "./fixtures.js";

describe("compareValue", () => {
  test("null < booleans < numbers < strings, natural order within a kind", () => {
    expect(compareValue(null, false)).toBe(-1);
    expect(compareValue(false, true)).toBe(-1);
    expect(compareValue(true, 0)).toBe(-1);
    expect(compareValue(1, 2)).toBe(-1);
    expect(compareValue(2, 1)).toBe(1);
    expect(compareValue(9, "a")).toBe(-1);
    expect(compareValue("a", "b")).toBe(-1);
    expect(compareValue("b", "b")).toBe(0);
    expect(compareValue(null, null)).toBe(0);
  });
});

describe("strategies", () => {
  const older = stamp(1, 0, PEER_A);
  const newer = stamp(2, 0, PEER_A);

  test("lww keeps the newer stamp regardless of value", () => {
    expect(strategies.lww(cell(1, newer), cell(9, older))).toEqual(cell(1, newer));
    expect(strategies.lww(cell(9, older), cell(1, newer))).toEqual(cell(1, newer));
  });

  test("max keeps the larger value even when its stamp is older (the bid)", () => {
    expect(strategies.max(cell(100, older), cell(90, newer))).toEqual(cell(100, older));
    expect(strategies.max(cell(90, newer), cell(100, older))).toEqual(cell(100, older));
  });

  test("min keeps the smaller value even when its stamp is older (the ask)", () => {
    expect(strategies.min(cell(5, older), cell(7, newer))).toEqual(cell(5, older));
    expect(strategies.min(cell(7, newer), cell(5, older))).toEqual(cell(5, older));
  });

  test("max / min on an exact value tie fall back to the newer stamp", () => {
    expect(strategies.max(cell(5, older), cell(5, newer))).toEqual(cell(5, newer));
    expect(strategies.min(cell(5, newer), cell(5, older))).toEqual(cell(5, newer));
    expect(strategies.max(cell(5, stamp(1, 0, PEER_A)), cell(5, stamp(1, 0, PEER_B)))).toEqual(
      cell(5, stamp(1, 0, PEER_B)),
    );
  });
});

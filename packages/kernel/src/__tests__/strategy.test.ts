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

  test("bytes and JSON containers rank above the scalars and order among themselves", () => {
    expect(compareValue("z", new Uint8Array([0]))).toBe(-1);
    expect(compareValue(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(-1);
    expect(compareValue(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(-1);
    expect(compareValue(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(0);
    expect(compareValue(new Uint8Array([9]), { a: 1 })).toBe(-1);
    expect(compareValue({ a: 1 }, { b: 1 })).toBe(-1);
    // key order is not part of the value: the same object built two ways compares equal
    expect(compareValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(0);
    expect(compareValue([1, 2], [1, 3])).toBe(-1);
  });

  test("a foreign value on a max column joins rather than throwing — a snapshot page carries any shape", () => {
    // a snapshot row or repair record comes from another peer and passes no `checkValue`, so a
    // json value on a numeric max column is something a peer can hand this fold at any time
    expect(() =>
      strategies.max(cell({ a: 1 }, stamp(1, 0, PEER_A)), cell(5, stamp(2, 0, PEER_A))),
    ).not.toThrow();
  });

  test("max stays a lattice over mixed shapes: every fold order of the same three cells agrees", () => {
    const object = cell({ a: 1 }, stamp(2, 0, PEER_A));
    const nine = cell(9, stamp(1, 0, PEER_A));
    const three = cell(3, stamp(3, 0, PEER_A));
    const orders = [
      [object, nine, three],
      [object, three, nine],
      [nine, object, three],
      [nine, three, object],
      [three, object, nine],
      [three, nine, object],
    ] as const;
    const folded = orders.map(([x, y, z]) => strategies.max(z, strategies.max(y, x)));
    for (const result of folded)
      expect(result).toEqual(strategies.max(three, strategies.max(nine, object)));
  });
});

describe("strategies", () => {
  const older = stamp(1, 0, PEER_A);
  const newer = stamp(2, 0, PEER_A);

  test("lastWrite keeps the newer stamp regardless of value", () => {
    expect(strategies.lastWrite(cell(1, newer), cell(9, older))).toEqual(cell(1, newer));
    expect(strategies.lastWrite(cell(9, older), cell(1, newer))).toEqual(cell(1, newer));
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

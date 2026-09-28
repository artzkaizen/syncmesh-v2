import { describe, expect, test } from "bun:test";

import type { MergeSpec } from "../strategy.js";

import { mergeRecord } from "../apply.js";
import { getRecord } from "../state.js";
import { counterValue } from "../strategy.js";
import {
  applyAll,
  canonicalState,
  cell,
  column,
  insert,
  N1,
  NOTES,
  PEER_A,
  PEER_B,
  record,
  stamp,
  update,
  type Stamped,
} from "./fixtures.js";

const STOCK = column("stock");
const COUNTER: MergeSpec = new Map([[NOTES, new Map([[STOCK, "counter" as const]])]]);

const a1 = stamp(1, 0, PEER_A);
const a2 = stamp(2, 0, PEER_A);
const b1 = stamp(1, 1, PEER_B);

const stockOf = (state: ReturnType<typeof applyAll>): number => {
  const held = getRecord(state, NOTES, N1)?.cells.get(STOCK);
  return held === undefined ? 0 : counterValue(held.value);
};

const inc = (n: number, at: typeof a1): Stamped => update({ stock: { "+": n } }, at);

describe("counter — the cell lww merges wrong (book ch. 2)", () => {
  test("concurrent +1/+1 folds to 2 on every holder, either order", () => {
    const forward = applyAll([inc(1, a1), inc(1, b1)], COUNTER);
    const backward = applyAll([inc(1, b1), inc(1, a1)], COUNTER);
    expect(stockOf(forward)).toBe(2);
    expect(canonicalState(forward)).toBe(canonicalState(backward));
  });

  test("the worked Tuesday: +24, then two sales apart, reads 21 everywhere", () => {
    const state = applyAll([inc(24, a1), inc(-2, a2), inc(-1, b1)], COUNTER);
    expect(stockOf(state)).toBe(21);
  });

  test("a snapshot in normal form joins idempotently: replaying it changes nothing", () => {
    const folded = applyAll([inc(24, a1), inc(-2, a2)], COUNTER);
    const held = getRecord(folded, NOTES, N1)?.cells.get(STOCK);
    if (held === undefined) throw new Error("the cell folded above");

    const snapshot = record(a2, [["stock", cell(held.value, held.stamp)]]);
    const once = mergeRecord(folded, NOTES, N1, snapshot, COUNTER);
    const twice = mergeRecord(once, NOTES, N1, snapshot, COUNTER);
    expect(canonicalState(once)).toBe(canonicalState(folded));
    expect(canonicalState(twice)).toBe(canonicalState(folded));
    expect(stockOf(twice)).toBe(22);
  });

  test("a first arrival normalizes: the increment shape never sits in state", () => {
    const state = applyAll([insert({ stock: { "+": 5 } }, a1)], COUNTER);
    const held = getRecord(state, NOTES, N1)?.cells.get(STOCK)?.value;
    expect(held).toEqual({ p: { [String(PEER_A)]: 5 }, n: {} });
    expect(stockOf(state)).toBe(5);
  });
});

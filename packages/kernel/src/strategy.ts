import { panic } from "@syncmesh/result";

import type { TableName } from "./change.js";
import type { Ordering } from "./primitives.js";
import type { Cell, CellValue, ColumnName } from "./record.js";

import { joinCounters } from "./counter.js";
import { joinSets } from "./set.js";
import { compareStamp } from "./stamp.js";

export type Strategy = (incoming: Cell, current: Cell) => Cell;

/**
 * `lww`, `max` and `min` pick one of the two cells whole; `counter` and `set` merge *inside* it and
 * are the column's kind rather than anything an app declares (E26, D04-C).
 */
export type StrategyName = "lww" | "max" | "min" | "counter" | "set";

export type MergeSpec = ReadonlyMap<TableName, ReadonlyMap<ColumnName, StrategyName>>;

/* oxlint-disable anti-slop/no-runtime-typeof -- CellValue is a closed union; typeof is its discriminant */
const rank = (v: CellValue) =>
  v === null
    ? 0
    : typeof v === "boolean"
      ? 1
      : typeof v === "number"
        ? 2
        : typeof v === "string"
          ? 3
          : panic("max/min compare scalars only; the schema refuses them on json and blob columns");
/* oxlint-enable anti-slop/no-runtime-typeof */

/** Total order on scalar cell values: null < booleans < numbers < strings, each by its natural order. Panics on json/blob — a definition defect. */
export function compareValue(a: CellValue, b: CellValue): Ordering {
  const byKind = rank(a) - rank(b);
  if (byKind !== 0) return byKind < 0 ? -1 : 1;
  if (a === b) return 0;
  // SAFETY: equal rank means equal runtime type, and null/boolean/number/string all support <
  return (a as number) < (b as number) ? -1 : 1;
}

const lww: Strategy = (incoming, current) =>
  compareStamp(incoming.stamp, current.stamp) > 0 ? incoming : current;

const byValue =
  (sign: 1 | -1): Strategy =>
  (incoming, current) => {
    const order = compareValue(incoming.value, current.value) * sign;
    return order > 0 ? incoming : order < 0 ? current : lww(incoming, current);
  };

/**
 * A cell whose value is itself a lattice: the two states join, and the stamp joins with them, so
 * the cell records the latest write that touched it rather than the one that decided it. Nothing
 * is discarded, which is why `counter` and `set` cells never need a tie-break.
 */
const joining =
  (join: (incoming: CellValue, current: CellValue) => CellValue): Strategy =>
  (incoming, current) => ({
    value: join(incoming.value, current.value),
    stamp: compareStamp(incoming.stamp, current.stamp) > 0 ? incoming.stamp : current.stamp,
  });

/**
 * `lww` picks the newer stamp; `max` / `min` pick by value and fall back to the stamp on an exact
 * tie; `counter` and `set` join the two values. All five are lattice joins — commutative,
 * associative and idempotent — which is the whole reason any delivery order lands on one state.
 */
export const strategies = {
  lww,
  max: byValue(1),
  min: byValue(-1),
  counter: joining(joinCounters),
  set: joining(joinSets),
} satisfies Readonly<Record<StrategyName, Strategy>>;

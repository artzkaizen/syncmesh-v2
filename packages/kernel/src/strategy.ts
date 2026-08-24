import type { TableName } from "./change.js";
import type { Ordering } from "./primitives.js";
import type { Cell, CellValue, ColumnName } from "./record.js";

import { compareStamp } from "./stamp.js";

export type Strategy = (incoming: Cell, current: Cell) => Cell;

export type StrategyName = "lww" | "max" | "min";

export type MergeSpec = ReadonlyMap<TableName, ReadonlyMap<ColumnName, StrategyName>>;

/* oxlint-disable anti-slop/no-runtime-typeof -- CellValue is a closed primitive union; typeof is its only discriminant */
const rank = (v: CellValue) =>
  v === null ? 0 : typeof v === "boolean" ? 1 : typeof v === "number" ? 2 : 3;
/* oxlint-enable anti-slop/no-runtime-typeof */

/** Total order on cell values: null < booleans < numbers < strings, each by its natural order. */
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

/** `lww` picks the newer stamp; `max` / `min` pick by value and fall back to the stamp on an exact tie. All three are lattice joins. */
export const strategies = {
  lww,
  max: byValue(1),
  min: byValue(-1),
} satisfies Readonly<Record<StrategyName, Strategy>>;

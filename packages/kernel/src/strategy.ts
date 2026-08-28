import type { TableName } from "./change.js";
import type { Ordering } from "./primitives.js";
import type { Cell, CellValue, ColumnName, JsonValue } from "./record.js";

import { joinCounters } from "./counter.js";
import { canonicalJson, joinSets } from "./set.js";
import { compareStamp } from "./stamp.js";

export type Strategy = (incoming: Cell, current: Cell) => Cell;

/**
 * The strategies that pick one of the two cells whole, and the only ones an app may name in
 * `onConflict`. A cell's *value* survives all three: whichever of the two cells wins, it is a cell
 * the author actually wrote.
 */
export type DeclaredStrategyName = "lww" | "max" | "min";

/**
 * `lww`, `max` and `min` pick one of the two cells whole; `counter` and `set` merge *inside* it and
 * are the column's kind rather than anything an app declares (E26, D04-C).
 */
export type StrategyName = DeclaredStrategyName | "counter" | "set";

/**
 * Whether the strategy merges inside the cell. These two read the cell as lattice state, so naming
 * one on a column whose writes are plain values replaces every one of them with the empty
 * lattice — which is why {@link DeclaredStrategyName} is what `onConflict` accepts, and why the
 * schema refuses these at runtime as well, where a cast could otherwise reach them.
 */
export const isCellStrategy = (name: StrategyName): boolean => name === "counter" || name === "set";

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
          : v instanceof Uint8Array
            ? 4
            : 5;
/* oxlint-enable anti-slop/no-runtime-typeof */

/** Byte order, shortest-prefix-first — the same order two peers reach from the same bytes. */
const compareBytes = (a: Uint8Array, b: Uint8Array): Ordering => {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};

/**
 * Total order on cell values: `null` < booleans < numbers < strings < bytes < JSON containers, each
 * by its natural order, containers by their canonical text.
 *
 * Total on **every** `CellValue` and never throwing, because the values it compares are not only
 * the ones a local schema declared: a snapshot page and a repair record carry cells straight from
 * another peer, and a `max` column whose value arrived as an object must still join to one answer
 * rather than take the fold down. A schema still refuses `max`/`min` on json and blob columns —
 * that check is what keeps an app from meaning this, not what keeps a peer from sending it.
 */
export function compareValue(a: CellValue, b: CellValue): Ordering {
  const byKind = rank(a) - rank(b);
  if (byKind !== 0) return byKind < 0 ? -1 : 1;
  if (a === b) return 0;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return compareBytes(a, b);
  if (rank(a) === 5) {
    // SAFETY: rank 5 is everything that is neither scalar nor bytes, which is JSON containers
    const [x, y] = [canonicalJson(a as JsonValue), canonicalJson(b as JsonValue)];
    return x === y ? 0 : x < y ? -1 : 1;
  }
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

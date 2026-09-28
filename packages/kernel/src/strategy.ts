import type { TableName } from "./change.js";
import type { Ordering } from "./primitives.js";
import type { Cell, CellValue, ColumnName, JsonValue } from "./record.js";

import { canonicalJson } from "./record.js";
import { compareStamp } from "./stamp.js";

export type Strategy = (incoming: Cell, current: Cell | undefined) => Cell;

/**
 * How a column merges when two devices wrote it while apart (D25). `lww`, `max` and `min` pick
 * one of the two cells **whole**, so the value that survives is always a value some author
 * actually wrote. `counter` is the exception the book names (ch. 2): writes are increments,
 * the cell is per-author totals, and the read is their sum — inventory merges wrong under
 * `lww`, which is why the schema names it.
 *
 * `lww` is last-writer-wins, by HLC stamp.
 */
export type StrategyName = "lww" | "max" | "min" | "counter";

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
  current === undefined || compareStamp(incoming.stamp, current.stamp) > 0 ? incoming : current;

const byValue =
  (sign: 1 | -1): Strategy =>
  (incoming, current) => {
    if (current === undefined) return incoming;
    const order = compareValue(incoming.value, current.value) * sign;
    return order > 0 ? incoming : order < 0 ? current : lww(incoming, current);
  };

/** One author's running total; the two sides of a counter cell each hold one per author. */
type AuthorTotals = Readonly<Record<string, number>>;

/** Per-author running totals, one map up (`p`) and one down (`n`); both only ever grow. */
interface Contributions {
  readonly p: AuthorTotals;
  readonly n: AuthorTotals;
}

/* oxlint-disable anti-slop/no-runtime-typeof -- CellValue is a closed union; typeof is its discriminant */
/** `{"+": n}` — the shape an increment travels in (book ch. 2); anything else is normal form. */
const deltaOf = (value: CellValue): number | undefined =>
  value !== null &&
  typeof value === "object" &&
  !(value instanceof Uint8Array) &&
  !Array.isArray(value) &&
  "+" in value &&
  typeof value["+"] === "number"
    ? value["+"]
    : undefined;

const contributionsOf = (value: CellValue): Contributions => {
  if (value === null || typeof value !== "object" || value instanceof Uint8Array)
    return { p: {}, n: {} };
  // SAFETY: a counter cell in normal form was written by `counter` below, as exactly this shape
  const held = value as { readonly p?: AuthorTotals; readonly n?: AuthorTotals };
  return { p: held.p ?? {}, n: held.n ?? {} };
};
/* oxlint-enable anti-slop/no-runtime-typeof */

const joinTotals = (a: AuthorTotals, b: AuthorTotals): AuthorTotals => {
  const joined = new Map(Object.entries(a));
  for (const [author, total] of Object.entries(b))
    joined.set(author, Math.max(joined.get(author) ?? 0, total));
  return Object.fromEntries(joined);
};

/**
 * A PN-counter per cell: the value is per-author totals up and down, the read is their sum.
 *
 * An arriving **increment** (`{"+": n}`) adds to its author's total — sound because the engine
 * folds each author's events exactly once and in order (dedup plus holdback). A cell already in
 * normal form — a snapshot row, a repair record — joins by per-author max, which is a lattice
 * because each author's totals only ever grow. The read lives in {@link counterValue}.
 */
const counter: Strategy = (incoming, current) => {
  const held = current === undefined ? { p: {}, n: {} } : contributionsOf(current.value);
  const stamp =
    current === undefined || compareStamp(incoming.stamp, current.stamp) > 0
      ? incoming.stamp
      : current.stamp;
  const delta = deltaOf(incoming.value);
  if (delta !== undefined) {
    const author = String(incoming.stamp.peer);
    const side = delta >= 0 ? "p" : "n";
    const grown = { ...held[side], [author]: (held[side][author] ?? 0) + Math.abs(delta) };
    const value = side === "p" ? { p: grown, n: held.n } : { p: held.p, n: grown };
    return { value, stamp };
  }
  const arrived = contributionsOf(incoming.value);
  return { value: { p: joinTotals(held.p, arrived.p), n: joinTotals(held.n, arrived.n) }, stamp };
};

/** What a `counter` cell reads as: every author's ups minus every author's downs. */
export function counterValue(value: CellValue): number {
  const { p, n } = contributionsOf(value);
  const sum = (totals: Readonly<Record<string, number>>) =>
    Object.values(totals).reduce((held, total) => held + total, 0);
  return sum(p) - sum(n);
}

/**
 * `lww` picks the newer stamp; `max` and `min` pick by value and fall back to the stamp on an
 * exact tie; `counter` accumulates. All four are lattice joins — commutative, associative and
 * idempotent over their normal forms — which is the whole reason any delivery order lands on
 * one state.
 */
export const strategies = {
  lww,
  max: byValue(1),
  min: byValue(-1),
  counter,
} satisfies Readonly<Record<StrategyName, Strategy>>;

/**
 * SQLite's own ordering of two cell values, in JavaScript.
 *
 * A maintained query decides in JS where a changed row belongs, and the answer has to be the one
 * the engine would have given: a row placed by a different rule than the `ORDER BY` that drew the
 * rest of the list is a row in the wrong place, and re-running the query would move it. So this
 * is SQLite's comparison and not JavaScript's — they differ in three places, and each of them
 * shows up in a real list.
 */

/**
 * One column's value, as a driver hands it back — Drizzle's mapping already applied, so a
 * `timestamp_ms` column is a `Date` here and a boolean-mode column a boolean, both of which
 * sort as the integers they were stored as.
 */
export type Cell = string | number | bigint | boolean | Date | Uint8Array | null | undefined;

/** A row as a live query holds it: the fields the projection named, each carrying one cell. */
export type Cells = Readonly<Record<string, Cell>>;

/**
 * SQLite's storage classes, in the order it sorts them.
 *
 * Mixed types in one column are rare but legal, and a nullable column is not rare at all:
 * `ORDER BY targetDate` over a table where most projects have no date is this rule doing the
 * visible work, because JavaScript would compare `null` as `0` and file every undated project
 * among the ones due in 1970.
 */
const NULLS = 0;
const NUMBERS = 1;
const TEXT = 2;
const BLOB = 3;

/* oxlint-disable anti-slop/no-runtime-typeof -- a comparator dispatches on the storage class of what it was handed, exactly as the engine does; the union above is the contract and `typeof` is how a value picks its arm of it */
const classOf = (value: Cell): number => {
  if (value === null || value === undefined) return NULLS;
  if (typeof value === "string") return TEXT;
  if (typeof value === "number" || typeof value === "bigint") return NUMBERS;
  if (typeof value === "boolean" || value instanceof Date) return NUMBERS;
  return BLOB;
};

const numberOf = (value: Cell): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  return Number(value);
};
/* oxlint-enable anti-slop/no-runtime-typeof */

/**
 * Text as SQLite's `BINARY` collation orders it: by UTF-8 bytes, which is code-point order.
 *
 * JavaScript's `<` is UTF-16 code-unit order, and the two disagree over one range — a character
 * above U+FFFF is a surrogate pair starting at U+D800, so `<` files it *below* everything from
 * U+E000 to U+FFFF, where UTF-8 puts it above. An emoji in an issue title is enough to hit it.
 * The scan below is the fast path either way; the code-point compare only runs at the first
 * position where a surrogate is involved.
 */
export const compareText = (left: string, right: string): number => {
  const shared = Math.min(left.length, right.length);
  for (let at = 0; at < shared; at += 1) {
    const one = left.charCodeAt(at);
    const other = right.charCodeAt(at);
    if (one === other) continue;
    if (one < 0xd800 && other < 0xd800) return one - other;
    return (left.codePointAt(at) ?? one) - (right.codePointAt(at) ?? other);
  }
  return left.length - right.length;
};

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const shared = Math.min(left.length, right.length);
  for (let at = 0; at < shared; at += 1) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

/** Negative, zero or positive, as `ORDER BY … ASC` would put `left` before, level with, or after `right`. */
export const compareCells = (left: Cell, right: Cell): number => {
  const kind = classOf(left);
  const against = classOf(right);
  if (kind !== against) return kind - against;
  if (kind === NULLS) return 0;
  if (kind === TEXT) return compareText(String(left), String(right));
  if (kind === NUMBERS) {
    const one = numberOf(left);
    const other = numberOf(right);
    return one < other ? -1 : one > other ? 1 : 0;
  }
  if (left instanceof Uint8Array && right instanceof Uint8Array) return compareBytes(left, right);
  // a value neither class knows: level, so it never invents an order the engine would not repeat
  return 0;
};

import { bytesEqual } from "@syncmesh/wire";

/**
 * `b`, with every part deeply equal to `a` replaced by `a`'s own reference.
 *
 * One pass does two jobs. `replaceEqualDeep(current, rows) === current` is the change decision —
 * cheaper than serialising, and it short-circuits on identity. Everything unchanged *inside* a
 * changed result keeps its old reference, so a memoised list row whose data did not move does not
 * re-render when its neighbour does.
 *
 * This replaces comparing `JSON.stringify(rows)`, which allocated a string the size of the whole
 * result on every fold and **threw** on a `bigint` — what SQLite hands back for an integer past
 * 2^53, which made a live query over such a column fail outright rather than return the wrong
 * answer.
 */

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- a structural comparison is defined over arbitrary values: it is the shape of a result, not its meaning, that is under test here, and there is no domain type to parse a row into that would not have to be re-parsed per query */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export function replaceEqualDeep<T>(a: unknown, b: T): T {
  if (Object.is(a, b)) return b;
  // bytes compare by content, or a blob column reads as changed on every fold
  if (a instanceof Uint8Array && b instanceof Uint8Array && bytesEqual(a, b)) {
    // SAFETY: `b` is a Uint8Array holding the same bytes, so `a` stands in for it as T
    return a as T;
  }

  const bothArrays = Array.isArray(a) && Array.isArray(b);
  if (!bothArrays && !(isPlainObject(a) && isPlainObject(b))) return b;

  // SAFETY: both branches above leave `a` and `b` as arrays or as plain objects, and an array is indexable by its numeric keys as strings
  const previous = a as Record<string, unknown>;
  // SAFETY: as `previous` — `b` is an array or a plain object here
  const next = b as Record<string, unknown>;
  const keys = Object.keys(next);
  const copy: Record<string, unknown> = {};

  let shared = 0;
  for (const key of keys) {
    const merged = replaceEqualDeep(previous[key], next[key]);
    copy[key] = merged;
    if (Object.hasOwn(previous, key) && Object.is(merged, previous[key])) shared += 1;
  }

  // every key of `b` matched one of `a`, and `a` has no key `b` lacks: `a` still describes `b`
  if (Object.keys(previous).length === keys.length && shared === keys.length) {
    // SAFETY: `a` was just shown deeply equal to `b`, so it is a `T`
    return a as T;
  }
  // SAFETY: `copy` was built key-for-key from `b`; for an array its values are its elements in order
  return (bothArrays ? Object.values(copy) : copy) as T;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof */

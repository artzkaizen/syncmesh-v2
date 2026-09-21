import type { LiveWindow } from "./window.js";

import { replaceEqualDeep } from "./equal.js";

/**
 * What moved between two deliveries of a live query, when the query could say.
 *
 * The delta is the thing a consumer actually wanted. TanStack DB's sync protocol is written in
 * these (`insert`/`update`/`delete` per key) and so is every list view worth the name: told that
 * one row changed, a collection writes one row, where a fresh array leaves it to re-key and
 * re-diff the whole list to rediscover the fact the fold already knew.
 */
export interface LiveChange<T> {
  readonly kind: "insert" | "update" | "delete";
  readonly key: string;
  /** The row as it now is — and for a `delete`, as it last was. */
  readonly row: T;
}

/** A maintained answer: the new rows, and the changes that got them there. */
export interface Patched<T> {
  readonly rows: readonly T[];
  readonly changes: readonly LiveChange<T>[];
}

/** Two runs already in the query's order, woven into one. */
const weave = <T>(left: readonly T[], right: readonly T[], order: (a: T, b: T) => number): T[] => {
  const woven: T[] = [];
  let here = 0;
  let there = 0;
  while (here < left.length && there < right.length) {
    const one = left[here];
    const other = right[there];
    if (one === undefined || other === undefined) break;
    if (order(one, other) <= 0) {
      woven.push(one);
      here += 1;
    } else {
      woven.push(other);
      there += 1;
    }
  }
  return [...woven, ...left.slice(here), ...right.slice(there)];
};

/** What the window holds now, split from what it held: the rows drawn, and the rows past the end. */
interface Woven<T> {
  readonly rows: readonly T[];
  readonly dropped: readonly T[];
}

/**
 * The delta between the window that was and the window that is, in the order a consumer applies
 * it — arrivals first, so a row that moved never looks momentarily absent.
 *
 * `held` is the rows that were on screen and whose keys the fold named; `dropped` is what the
 * limit pushed past the end. A row in either that is not in the new window has left it, whether
 * it stopped matching, was deleted, or was simply crowded out.
 */
const changesOf = <T>(
  plan: LiveWindow<T>,
  held: ReadonlyMap<string, T>,
  arrived: readonly T[],
  { dropped }: Woven<T>,
): readonly LiveChange<T>[] => {
  const { keyOf } = plan;
  const staying = new Set(arrived.map(keyOf));
  const past = new Set(dropped.map(keyOf));
  const gone = new Map(held);
  // a dropped row that the probe brought back was never on screen to begin with; one that came
  // out of the cached window was
  for (const row of dropped) if (!staying.has(keyOf(row))) gone.set(keyOf(row), row);

  const changes: LiveChange<T>[] = [];
  for (const row of arrived) {
    const key = keyOf(row);
    if (past.has(key)) continue; // it matches the query, but not inside this window
    const before = gone.get(key);
    gone.delete(key);
    // a write that changed nothing this query selects left the row object alone; saying it
    // changed would wake every listener for nothing
    if (before !== row)
      changes.push({ kind: before === undefined ? "insert" : "update", key, row });
  }
  for (const [key, row] of gone) changes.push({ kind: "delete", key, row });
  return changes;
};

/**
 * The limit applied — or `undefined` where applying it would need a row nobody read.
 *
 * The `>= limit` test is the one thing a page may not infer from its own length, and here it is
 * inferred *towards* doubt: a list of exactly `limit` rows may or may not have been truncated,
 * and this treats it as though it was, which costs a re-read and can never lose a row.
 */
/* oxlint-disable syncmesh/no-length-against-limit -- the ambiguity at exactly the limit is what this function exists to handle rather than to avoid: it reads "maybe truncated" as "truncated" and falls back to the store, so the doubt the rule is about costs a re-read and can never lose a row */
const cut = <T>(
  plan: LiveWindow<T>,
  cached: readonly T[],
  woven: readonly T[],
): Woven<T> | undefined => {
  const { order, limit } = plan;
  if (limit === undefined) return { rows: woven, dropped: [] };
  // taken from the rows as they were, before anything was spliced: the hidden rows sorted after
  // *this* row's old values, and this row may be one of the ones that just changed
  const boundary = cached.length >= limit ? cached[limit - 1] : undefined;
  if (boundary !== undefined) {
    const last = woven[limit - 1];
    if (last === undefined || order(last, boundary) > 0) return undefined;
  }
  return woven.length <= limit
    ? { rows: woven, dropped: [] }
    : { rows: woven.slice(0, limit), dropped: woven.slice(limit) };
};
/* oxlint-enable syncmesh/no-length-against-limit */

/**
 * The window's new contents, or `undefined` to say they cannot be known from what is in hand.
 *
 * `probed` is the current state of exactly the keys the fold wrote, read back through the same
 * `WHERE` — so a key missing from it either no longer matches the filter or no longer exists, and
 * either way it leaves the list. Everything else keeps the row object it already had, which is
 * what stops a memoised list item re-rendering because an unrelated row moved.
 *
 * ## When it gives up
 *
 * A full window — one the `LIMIT` truncated — hides rows, and the only thing known about them is
 * that they sorted after the last row drawn. So a patch is trustworthy exactly while it does not
 * reach that boundary: if the window would come up short, or if its new last row sorts *after*
 * the old last row, a hidden row belongs in it and the query must be re-read. That is a `DELETE`
 * from a full list, and it is meant to fall through — the alternative is a list that quietly
 * drops its last row every time somebody archives something.
 */
export const patchWindow = <T>(
  plan: LiveWindow<T>,
  cached: readonly T[],
  keys: ReadonlySet<string>,
  probed: readonly T[],
): Patched<T> | undefined => {
  const { keyOf, order } = plan;
  const held = new Map<string, T>();
  const kept: T[] = [];
  for (const row of cached) {
    const key = keyOf(row);
    if (keys.has(key)) held.set(key, row);
    else kept.push(row);
  }

  // a write that did not change what this query selects keeps the row it had, so the change list
  // comes back empty and nothing downstream is told anything happened
  const arrived = probed.map((row) => {
    const before = held.get(keyOf(row));
    return before === undefined ? row : replaceEqualDeep(before, row);
  });

  const woven = weave(kept, arrived, order);
  const settled = cut(plan, cached, woven);
  if (settled === undefined) return undefined;

  const changes = changesOf(plan, held, arrived, settled);
  // nothing moved: the caller keeps the array it published, and no listener is woken at all
  return changes.length === 0 ? { rows: cached, changes } : { rows: settled.rows, changes };
};

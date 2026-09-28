import { panic } from "@syncmesh/result";

/**
 * Manual order, as a string that sorts.
 *
 * A tracker's backlog is dragged into an order a person means, and the order has to survive two
 * people dragging on two planes. The three candidates:
 *
 * - **An integer position.** Moving one card renumbers every card below it, so one drag is
 *   hundreds of writes, and two offline drags produce two whole renumberings that last-writer-
 *   wins collapses into one — the other person's drag is simply gone.
 * - **A linked list** (`afterId` on each row). One write per move, but a cycle is one concurrent
 *   pair of moves away, and repairing a cycle is a global read no device can do offline.
 * - **A fractional index**: a string key, ordered lexicographically, and a move writes exactly
 *   one cell — the moved row's own. Nothing else is touched, so nothing else can be clobbered,
 *   and the merge is the ordinary last-writer-wins the column already has.
 *
 * The third is what everyone converges on (Figma, Linear, LiveStore's clone via
 * `fractional-indexing`) and what this is. It is written out here rather than taken as a
 * dependency only because this wave could not add one to the lockfile; the algorithm is
 * Greenspan's, base 62.
 *
 * **Where it still needs care.** Two devices that drag two different issues into the same gap
 * compute the *same* key, because the inputs are the same. Nothing is lost — they are different
 * rows, each keeping its own value — but the two now tie, and a tie that SQLite breaks by row
 * order breaks differently on each device. Two things fix that together, and both are load-
 * bearing:
 *
 * 1. Every key gets a short random suffix ({@link between}), so the same gap rarely yields the
 *    same key twice.
 * 2. Every ordered read sorts by `(rank, id)`, never `rank` alone. A tie then falls back to a
 *    value both devices already agree on, so even a genuine collision shows the same order in
 *    both places — which is the property that actually matters. "Same order everywhere" is the
 *    promise; "the order the second dragger intended" is not one any scheme can keep.
 */

/** Base 62, in ASCII order, so plain string comparison is the order — as SQLite's TEXT collation is. */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

/** The key of a first and only row. Mid-alphabet, so the list can grow either way without lengthening. */
export const FIRST_RANK = "V";

const digitAt = (key: string, index: number): number => {
  const digit = DIGITS.indexOf(key[index] ?? "0");
  return digit === -1 ? panic(`rank: "${key}" is not a base-62 key`) : digit;
};

/**
 * A key strictly between two keys, either of which may be absent (the ends of the list).
 *
 * Recursive on the shared prefix: equal leading digits are copied and the decision is made on
 * the first that differs, which is what keeps keys short — appending to a list grows them by one
 * digit every 62 rows rather than one every row.
 */
function midpoint(lower: string, upper: string | undefined): string {
  if (upper === undefined) return below(lower, BASE, undefined);
  if (lower >= upper)
    panic(`rank: ${lower} is not below ${upper}; the neighbours are out of order`);
  const shared = sharedDigits(lower, upper);
  return shared === 0
    ? below(lower, upper === "" ? BASE : digitAt(upper, 0), upper)
    : upper.slice(0, shared) + midpoint(lower.slice(shared), upper.slice(shared));
}

/** How many leading digits the two keys agree on, an absent digit reading as `0`. */
function sharedDigits(lower: string, upper: string): number {
  let shared = 0;
  while (shared < upper.length && (lower[shared] ?? "0") === upper[shared]) shared += 1;
  return shared;
}

/**
 * The answer once the first differing digit is known: halfway between them where there is room,
 * and otherwise one place further down — which is where a key grows a digit.
 */
function below(lower: string, high: number, upper: string | undefined): string {
  const low = lower === "" ? 0 : digitAt(lower, 0);
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)] ?? panic("rank: no such digit");
  if (upper !== undefined && upper.length > 1) return upper.slice(0, 1);
  return (DIGITS[low] ?? panic("rank: no such digit")) + midpoint(lower.slice(1), undefined);
}

/** Four random base-62 digits, never ending in `0` — a trailing zero has no key below it. */
function jitter(): string {
  let suffix = "";
  for (let place = 0; place < 4; place += 1)
    suffix += DIGITS[Math.floor(Math.random() * BASE)] ?? "1";
  return suffix.endsWith("0") ? `${suffix.slice(0, -1)}1` : suffix;
}

/**
 * The key for a row dropped between `lower` and `upper`; pass `null` for the top or bottom of
 * the list. The suffix is what makes two devices dropping into the same gap disagree rather than
 * collide, which is cheaper than either of them discovering the collision later.
 *
 * The suffix is dropped in the one case where it would reorder the row past its upper
 * neighbour — the midpoint of two adjacent digits is a *prefix* of the upper key, and anything
 * appended to a prefix can sort above it. Losing the jitter there loses only the tie-avoidance,
 * and the `(rank, id)` sort behind it still agrees on both devices.
 */
export function between(lower: string | null, upper: string | null): string {
  if (lower === null && upper === null) return FIRST_RANK;
  const key = midpoint(lower ?? "", upper ?? undefined);
  const scattered = key + jitter();
  return upper === null || scattered < upper ? scattered : key;
}

/**
 * `count` keys in order, evenly spaced — what a seed or a bulk import wants.
 *
 * Not `between(previous, null)` in a loop: appending to the end of an unbounded list is the one
 * case this simplified scheme handles badly, since each new key can only take half the room
 * left above the last, and a hundred of them grow long. Spacing them over the whole two-digit
 * range up front leaves every gap the same size, which is also what makes a seeded backlog
 * pleasant to drag around afterwards.
 */
export function sequence(count: number): readonly string[] {
  const span = BASE * BASE;
  if (count >= span) panic(`rank: ${count} keys is more than two base-62 digits can space`);
  const keys: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const slot = Math.floor(((index + 1) * span) / (count + 1));
    // a trailing "1" rather than the slot's own low digit: no key here ever ends in "0", which
    // is the one shape `midpoint` has nothing to put below
    keys.push(`${DIGITS[Math.floor(slot / BASE)] ?? ""}${DIGITS[slot % BASE] ?? ""}1`);
  }
  return keys;
}

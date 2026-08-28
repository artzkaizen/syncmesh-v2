import { panic } from "@syncmesh/result";

import type { PeerId } from "./peer-id.js";

import { jsonObject, type CellValue } from "./record.js";

/**
 * One peer's lifetime totals for a counter column: everything it has ever added under `inc`, ever
 * subtracted under `dec`. Two monotone halves rather than one signed number, because `max` is only
 * a join on something that never goes down — a signed total would let +1 then −1 read as −1.
 */
export type CounterEntry = Readonly<Record<"inc" | "dec", number>>;

/** A PN-counter cell: every peer's own totals, keyed by peer id. No peer ever writes another's entry. */
export type CounterState = Readonly<Record<string, CounterEntry>>;

const ZERO = { dec: 0, inc: 0 } satisfies CounterEntry;

/* oxlint-disable anti-slop/no-runtime-typeof -- a total, lenient reader of foreign numbers dispatches on their runtime type */
const total = (value: CellValue | undefined): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
/* oxlint-enable anti-slop/no-runtime-typeof */

/**
 * Reads a cell as counter state. Every unreadable shape — a wrong kind, a negative total, a peer
 * key holding a string — reads as zero rather than raising, because a fold that throws on one
 * device and succeeds on another is divergence with extra steps.
 */
export function readCounter(value: CellValue | undefined) {
  const object = jsonObject(value);
  if (object === undefined) return {};
  const state: Record<string, CounterEntry> = {};
  for (const peer of Object.keys(object).sort()) {
    const entry = jsonObject(object[peer]);
    if (entry !== undefined) state[peer] = { dec: total(entry.dec), inc: total(entry.inc) };
  }
  return state;
}

/**
 * Per peer, per direction, the larger total. Commutative, associative and idempotent because `max`
 * is: two devices that increment concurrently both keep their increment, and the same event folded
 * twice changes nothing.
 */
export function joinCounters(a: CellValue, b: CellValue) {
  const left = readCounter(a);
  const right = readCounter(b);
  const state: Record<string, CounterEntry> = {};
  for (const peer of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const l = left[peer] ?? ZERO;
    const r = right[peer] ?? ZERO;
    state[peer] = { dec: Math.max(l.dec, r.dec), inc: Math.max(l.inc, r.inc) };
  }
  return state;
}

/** Σ inc − Σ dec across every peer: what a `counter` column reads as. */
export function counterValue(value: CellValue | undefined): number {
  let sum = 0;
  for (const entry of Object.values(readCounter(value))) sum += entry.inc - entry.dec;
  return sum;
}

/**
 * The author's own totals after moving its counter by `by` — the payload an `increment` change
 * carries. It is the running total and not the step, because `max` cannot tell a re-delivered step
 * from a new one and would count it twice.
 *
 * A fractional or unsafe `by` throws, and so does one whose *running total* would leave the safe
 * range: either reads back as zero on the next fold, silently losing every increment this peer had
 * ever made.
 */
export function counterAdvance(
  current: CellValue | undefined,
  peer: PeerId,
  by: number,
): CounterEntry {
  if (!Number.isSafeInteger(by)) panic(`increment by ${by}: expected a safe integer`);
  const entry = readCounter(current)[peer] ?? ZERO;
  const next =
    by >= 0 ? { dec: entry.dec, inc: entry.inc + by } : { dec: entry.dec - by, inc: entry.inc };
  // the *total* is what the next fold reads back, and `readCounter` reads an unsafe one as zero:
  // a legal step that pushes the running total over the edge would lose this peer's whole history
  if (!Number.isSafeInteger(next.inc) || !Number.isSafeInteger(next.dec))
    panic(`increment by ${by}: the running total would leave the safe integer range`);
  return next;
}

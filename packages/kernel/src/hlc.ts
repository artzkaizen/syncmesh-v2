import { Temporal } from "@syncmesh/temporal";

import type { Brand, Ordering } from "./primitives.js";

/** A hybrid logical clock stamp: a wall-clock instant, then a per-millisecond counter. See RFC-0003. */
export type Hlc = readonly [physical: Temporal.Instant, logical: Logical];

/** Tie-breaker between stamps that share an instant. */
export type Logical = Brand<number, "Logical">;

export interface HlcClock {
  /** Returns a stamp greater than every stamp this clock has issued or received. */
  readonly tick: () => Hlc;
  readonly receive: (remote: Hlc) => void;
  readonly last: () => Hlc;
}

export interface HlcClockOptions {
  readonly now: () => Temporal.Instant;
  /** Maximum lead a received stamp may have over `now()`. */
  readonly maxDrift?: Temporal.Duration;
}

const logical = (n: number): Logical => {
  // SAFETY: Logical is a branded non-negative integer; every caller passes 0 or a previous Logical + 1
  return n as Logical;
};

const ZERO = logical(0);
const EPOCH = Temporal.Instant.fromEpochMilliseconds(0);

/**
 * Creates a clock whose stamps never go backwards, even when `now()` does.
 *
 * @example
 * const clock = createHlcClock({ now: () => Temporal.Now.instant() });
 * compareHlc(clock.tick(), clock.tick()); // -1
 */
export function createHlcClock(options: HlcClockOptions): HlcClock {
  const { now, maxDrift } = options;
  let last: Hlc = [EPOCH, ZERO];

  const tick = (): Hlc => {
    const wall = now();
    const [physical, previous] = last;
    last =
      Temporal.Instant.compare(wall, physical) > 0
        ? [wall, ZERO]
        : [physical, logical(previous + 1)];
    return last;
  };

  const receive = (remote: Hlc): void => {
    const bounded = maxDrift === undefined ? remote : clamp(remote, now().add(maxDrift));
    if (compareHlc(bounded, last) > 0) last = bounded;
  };

  return { tick, receive, last: () => last };
}

const clamp = (stamp: Hlc, limit: Temporal.Instant): Hlc =>
  Temporal.Instant.compare(stamp[0], limit) > 0 ? [limit, stamp[1]] : stamp;

/** Total order on stamps: instant first, then logical counter. */
/**
 * A stamp from the two integers every stored form keeps it as — CBOR ints, SQL columns, a wire
 * frame. The pair is the whole value, so this is the one place that reassembles it.
 */
export function hlcOf(ms: number, logical: number): Hlc {
  // SAFETY: both come from a form that was written from an Hlc; Logical is a non-negative integer
  return [instantAt(ms), logical as Logical];
}

/**
 * How many distinct milliseconds {@link instantAt} keeps before it starts over.
 *
 * Large enough to cover the burst this exists for — a replica rebuilding its state, where every
 * cell of every row asks for an instant and a row's cells all share one — and small enough that a
 * process running for weeks cannot grow a map for every millisecond it has ever seen.
 */
const INSTANT_CACHE = 4096;

const instants = new Map<number, Temporal.Instant>();

/**
 * The instant for this millisecond, built once.
 *
 * `Temporal.Instant` holds nanoseconds as a `BigInt`, so constructing one is far from free on an
 * engine without fast bignums — and the cells of a single row were written together and therefore
 * all carry the same millisecond. Instants are immutable, so handing the same one to every cell
 * that asks for it is a shared value rather than shared state.
 */
function instantAt(ms: number): Temporal.Instant {
  const known = instants.get(ms);
  if (known !== undefined) return known;
  const at = Temporal.Instant.fromEpochMilliseconds(ms);
  // cleared rather than evicted one at a time: this is a burst cache, and the burst starts over
  if (instants.size >= INSTANT_CACHE) instants.clear();
  instants.set(ms, at);
  return at;
}

export function compareHlc(a: Hlc, b: Hlc): Ordering {
  const byInstant = Temporal.Instant.compare(a[0], b[0]);
  if (byInstant < 0) return -1;
  if (byInstant > 0) return 1;
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

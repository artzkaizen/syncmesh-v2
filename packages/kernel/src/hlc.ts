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
export function compareHlc(a: Hlc, b: Hlc): Ordering {
  const byInstant = Temporal.Instant.compare(a[0], b[0]);
  if (byInstant < 0) return -1;
  if (byInstant > 0) return 1;
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

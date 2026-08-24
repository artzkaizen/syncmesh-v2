import type { Temporal } from "@syncmesh/temporal";

import { panic } from "@syncmesh/result";

/** A hybrid logical clock stamp: a wall-clock instant, then a per-millisecond counter. See RFC-0003. */
export type HLC = readonly [physical: Temporal.Instant, logical: Logical];

/** Tie-breaker between stamps that share an instant. */
export type Logical = number & { readonly __brand: "Logical" };

/** Issues strictly increasing {@link HLC} stamps for one device. */
export interface HlcClock {
  /** Returns a stamp greater than every stamp this clock has issued or received. */
  readonly tick: () => HLC;
  /** Records a stamp received from another peer. */
  readonly receive: (remote: HLC) => void;
  /** Returns the latest stamp issued or received, without advancing. */
  readonly last: () => HLC;
}

/** Options for {@link createHlcClock}. */
export interface HlcClockOptions {
  /** Source of wall-clock time. */
  readonly now: () => Temporal.Instant;
  /** Maximum lead a received stamp may have over `now()`. */
  readonly maxDrift?: Temporal.Duration;
}

/**
 * Creates a clock whose stamps never go backwards, even when `now()` does.
 *
 * @example
 * const clock = createHlcClock({ now: () => Temporal.Now.instant() });
 * compareHlc(clock.tick(), clock.tick()); // -1
 */
export function createHlcClock(_options: HlcClockOptions): HlcClock {
  return panic("not implemented");
}

/** Total order on stamps: instant first, then logical counter. */
export function compareHlc(_a: HLC, _b: HLC): -1 | 0 | 1 {
  return panic("not implemented");
}

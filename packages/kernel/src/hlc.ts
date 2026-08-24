import type { Temporal } from "@syncmesh/temporal";

import { panic } from "@syncmesh/result";

/** A hybrid logical clock stamp: a wall-clock instant, then a per-millisecond counter. See RFC-0003. */
export type Hlc = readonly [physical: Temporal.Instant, logical: Logical];

/** The counter half of an {@link Hlc}; 0 whenever the instant advances. */
export type Logical = number & { readonly __brand: "Logical" };

/** Issues strictly increasing {@link Hlc} stamps for one device. */
export interface HlcClock {
  /** Returns a stamp greater than every stamp this clock has issued or received. */
  readonly tick: () => Hlc;
  /** Records a stamp received from another peer so later ticks stay ahead of it. */
  readonly receive: (remote: Hlc) => void;
  /** Returns the latest stamp issued or received, without advancing. */
  readonly last: () => Hlc;
}

/** Options for {@link createHlcClock}. */
export interface HlcClockOptions {
  /** Source of wall-clock time. */
  readonly now: () => Temporal.Instant;
  /** Remote stamps further ahead of `now()` than this are clamped instead of adopted. */
  readonly maxDrift?: Temporal.Duration;
}

/**
 * Creates a clock whose stamps never go backwards, even when `now()` does.
 *
 * @example
 * const clock = createHlcClock({ now: () => Temporal.Now.instant() });
 * const a = clock.tick();
 * const b = clock.tick();
 * compareHlc(a, b); // -1
 */
export function createHlcClock(_options: HlcClockOptions): HlcClock {
  return panic("not implemented");
}

/** Total order on stamps: instant first, then logical counter. */
export function compareHlc(_a: Hlc, _b: Hlc): -1 | 0 | 1 {
  return panic("not implemented");
}

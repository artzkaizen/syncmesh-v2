import type { Temporal } from "@syncmesh/temporal";

import { panic } from "@syncmesh/result";

/**
 * Hybrid logical clock — E01, RFC-0003.
 *
 * `[physical, logical]`: a wall-clock instant plus a counter that only matters when two
 * stamps share the same millisecond. Strictly monotonic on one device even when the wall
 * clock jumps backwards; receiving a remote stamp ratchets the local clock forward so
 * causality is never inverted.
 *
 * On the wire (E03) `physical` is encoded as `epochMilliseconds`; in memory it is an
 * `Instant`, so it cannot be confused with a duration or an arbitrary number.
 */
export type Hlc = readonly [physical: Temporal.Instant, logical: Logical];

/** Tie-breaker within one millisecond. Resets to 0 whenever `physical` advances. */
export type Logical = number & { readonly __brand: "Logical" };

export interface HlcClock {
  /** A new stamp strictly greater than every stamp this clock has produced or received. */
  readonly tick: () => Hlc;
  /** Fold in a stamp seen from another peer; the next `tick()` is greater than it. */
  readonly receive: (remote: Hlc) => void;
  /** The last stamp produced or received, without advancing. */
  readonly last: () => Hlc;
}

export interface HlcClockOptions {
  /** Wall clock. Injected so tests can drive it backwards. */
  readonly now: () => Temporal.Instant;
  /** A remote stamp further than this ahead of `now()` is a broken clock, not the future. */
  readonly maxDrift?: Temporal.Duration;
}

export function createHlcClock(_options: HlcClockOptions): HlcClock {
  return panic("not implemented");
}

/** Total order: physical first, then logical. */
export function compareHlc(_a: Hlc, _b: Hlc): -1 | 0 | 1 {
  return panic("not implemented");
}

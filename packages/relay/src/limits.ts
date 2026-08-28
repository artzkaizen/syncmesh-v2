import { Temporal } from "@syncmesh/temporal";

/**
 * What a socket is spending on. Two classes rather than one because a blob frame is megabytes
 * and an event frame is bytes: a single bucket generous enough for a catch-up push is generous
 * enough for a blob flood, and one tight enough for blobs hangs up on the honest client the
 * relay just finished paging.
 */
export type TrafficClass = "event" | "blob";

export interface RateLimit {
  /**
   * Frames admitted back-to-back before the rate applies at all. Size it above the client's join
   * preamble — the `join` frame plus one grant frame per grant the device holds — or the limit is
   * a **livelock rather than a slowdown**: every reconnect spends the whole allowance on the same
   * preamble, is hung up on before its first event, and the room never accepts anything from that
   * device again. Above the preamble it is only a slowdown, because a client pushes everything the
   * relay lacks the moment its last catch-up page lands (E12) and the next reconnect resumes from
   * its cursors.
   */
  readonly burst: number;
  /** How long one spent token takes to come back; the steady-state cost of a frame. */
  readonly every: Temporal.Duration;
}

/** What one socket may spend. Nothing here is negotiated: the relay states it and enforces it. */
export interface RelayLimits {
  /**
   * The largest frame the relay will decode. It is a blob cap in disguise — `blob-put` is the
   * only frame that carries bulk — so a room whose app puts larger blobs must raise it, and a
   * log-only room should lower it to something an event never approaches.
   */
  readonly maxFrameBytes: number;
  readonly rates: Readonly<Record<TrafficClass, RateLimit>>;
}

export const DEFAULT_LIMITS = {
  maxFrameBytes: 8 * 1024 * 1024,
  rates: {
    event: { burst: 4096, every: Temporal.Duration.from({ milliseconds: 1 }) },
    blob: { burst: 64, every: Temporal.Duration.from({ milliseconds: 100 }) },
  },
} satisfies RelayLimits;

/** One socket's allowance, drawn down per frame. */
export interface Budget {
  /**
   * Spends one token of that class, or answers `false` because there was none. `false` is a
   * hang-up, never a wait: buffering a client that is over its rate is the exhaustion the
   * ceiling exists to prevent, and its reconnect re-requests from cursors and loses nothing.
   */
  readonly take: (traffic: TrafficClass) => boolean;
}

interface Bucket {
  readonly tokens: number;
  readonly at: Temporal.Instant;
}

/**
 * A token bucket per class, refilled from elapsed time rather than a timer — a relay holding ten
 * thousand sockets cannot afford ten thousand intervals, and a bucket nobody is spending from
 * costs nothing to keep. Tokens carry a fraction, so a steady drip at exactly the declared rate
 * is admitted forever; flooring each refill would quietly enforce a slower rate than the one
 * configured.
 */
export function createBudget(limits: RelayLimits, now: () => Temporal.Instant): Budget {
  const held = new Map<TrafficClass, Bucket>();
  return {
    take: (traffic) => {
      const rate = limits.rates[traffic];
      const current = now();
      const bucket = held.get(traffic);
      const everyMs = rate.every.total({ unit: "milliseconds" });
      const gained =
        bucket === undefined || everyMs <= 0
          ? rate.burst
          : bucket.tokens + bucket.at.until(current).total({ unit: "milliseconds" }) / everyMs;
      const tokens = Math.min(rate.burst, gained);
      const spent = tokens >= 1;
      held.set(traffic, { tokens: spent ? tokens - 1 : tokens, at: current });
      return spent;
    },
  };
}

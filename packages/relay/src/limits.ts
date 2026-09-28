import { Temporal } from "@syncmesh/temporal";

/**
 * What a socket is spending on. Two classes rather than one because a blob frame is megabytes
 * and an event frame is bytes: a single bucket generous enough for a catch-up push is generous
 * enough for a blob flood, and one tight enough for blobs hangs up on the honest client the
 * relay just finished paging.
 */
/**
 * `fanout` is not a frame class — nothing arrives under it. It is what a socket's frames *cost
 * the room*: one token per client an event was delivered to (gap audit №7).
 *
 * Ingress metering alone prices a flood at what it costs to receive, which is the cheap half. A
 * single event in a room of five hundred is five hundred sends, and a client that can push four
 * thousand frames a second can make the relay do two million — the amplification vector, and the
 * one a per-socket frame rate does not see.
 */
export type TrafficClass = "event" | "blob" | "fanout";

export interface RateLimit {
  /**
   * Frames admitted back-to-back before the rate applies at all. Size it above the client's join
   * preamble — the `join` frame plus one grant frame per grant the device holds — or the limit is
   * a **livelock rather than a slowdown**: every reconnect spends the whole allowance on the same
   * preamble, is hung up on before its first event, and the room never accepts anything from that
   * device again. Above the preamble it is only a slowdown, because a client pushes everything the
   * relay lacks the moment its last catch-up page lands and the next reconnect resumes from
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
  /**
   * Live sockets across the whole process; the one past the cap is refused at upgrade with 503,
   * before any handshake spend. A relay with no ceiling is an amplification vector waiting for
   * its crowd (gap audit №5) — reconnects retry, so a refused client heals itself.
   */
  readonly maxConnections: number;
  /**
   * Bytes a stalled socket may hold queued before the relay hangs up on it. Counted in bytes,
   * not frames: a thousand near-`maxFrameBytes` blob frames is gigabytes of retained buffers,
   * which is the OOM the ceiling exists to prevent (gap audit №6).
   */
  readonly maxBacklogBytes: number;
  readonly rates: Readonly<Record<TrafficClass, RateLimit>>;
}

export const DEFAULT_LIMITS = {
  maxFrameBytes: 8 * 1024 * 1024,
  maxConnections: 10_000,
  maxBacklogBytes: 64 * 1024 * 1024,
  rates: {
    event: { burst: 4096, every: Temporal.Duration.from({ milliseconds: 1 }) },
    blob: { burst: 64, every: Temporal.Duration.from({ milliseconds: 100 }) },
    /**
     * Deliveries this socket may cause. Nominal, and stated as such: the right number depends on
     * the room's size and how chatty its app is, and inventing a measured-looking one would make
     * a guess look considered. What the default *is* chosen to do is leave an ordinary client in
     * an ordinary room untouched while stopping a device that pushes a whole catch-up into a
     * crowd — roughly a hundred thousand deliveries back to back, then twenty thousand a second.
     */
    fanout: { burst: 100_000, every: Temporal.Duration.from({ microseconds: 50 }) },
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
  /**
   * Spends tokens for work already done, and never refuses — the sends have happened.
   *
   * Charging after the fact is the only honest order for fan-out: how many clients an event
   * reaches is not known until it has reached them, and holding it to find out would be the
   * latency the whole relay exists to avoid. What the charge buys is the *next* frame from this
   * socket being unaffordable, which is how a flood stops after one round instead of never.
   */
  readonly charge: (traffic: TrafficClass, count: number) => void;
  /**
   * Whether this class is in debt — {@link charge} took more than there was.
   *
   * Asked rather than spent, because a frame that causes no fan-out should cost no fan-out: an
   * event in a room of one is not amplification, and taxing it would meter the wrong thing.
   */
  readonly owes: (traffic: TrafficClass) => boolean;
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

  /** What this class has to spend right now, refilled from the time since it was last asked. */
  const available = (traffic: TrafficClass, current: Temporal.Instant): number => {
    const rate = limits.rates[traffic];
    const bucket = held.get(traffic);
    const everyMs = rate.every.total({ unit: "milliseconds" });
    const gained =
      bucket === undefined || everyMs <= 0
        ? rate.burst
        : bucket.tokens + bucket.at.until(current).total({ unit: "milliseconds" }) / everyMs;
    return Math.min(rate.burst, gained);
  };

  return {
    take: (traffic) => {
      const current = now();
      const tokens = available(traffic, current);
      const spent = tokens >= 1;
      held.set(traffic, { tokens: spent ? tokens - 1 : tokens, at: current });
      return spent;
    },
    owes: (traffic) => available(traffic, now()) < 1,
    charge: (traffic, count) => {
      if (count <= 0) return;
      const current = now();
      // it may go negative, and it must: a socket that caused more sends than it could afford
      // owes them, and owing is what makes the next frame wait rather than the debt vanishing
      held.set(traffic, { tokens: available(traffic, current) - count, at: current });
    },
  };
}

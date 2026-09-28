import type { TelemetryEvent, TelemetryListener } from "./telemetry.js";

/**
 * The consumer for the telemetry union (D17, gap audit №24).
 *
 * All three layers emit; until now nothing read. That is the failure mode D17 warned about from
 * the other direction — a panel that was always blank — and the answer is the same shape as the
 * union itself: one reader, over the whole union, that a relay and a device can both be handed.
 *
 * It counts and it times, and it does neither cleverly. What it is for is the two questions
 * worth asking of a running mesh — *how big was it* and *how long did it take* — answered per
 * event type without a caller narrowing to a variant first, because every variant carries
 * `sizes` and `duration` for exactly that reason.
 *
 * **The percentiles are over the last `keep` samples, not over all time.** A running process
 * cannot hold every duration it ever measured, and a reservoir that silently forgot would report
 * an all-time p95 it never computed. Reading the recent window is the honest version, and it is
 * also the one an operator wants: a relay that got slow an hour ago and recovered is not slow.
 */

export interface Durations {
  readonly totalMs: number;
  readonly meanMs: number;
  /** Over the last `keep` samples of this type — see the note on {@link createInspector}. */
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface TelemetryStats {
  readonly type: TelemetryEvent["type"];
  readonly count: number;
  /**
   * Every `sizes` field this type carried, summed under its own name — `bytes`, `events`,
   * `receivers`, whatever a variant declares. Summed rather than averaged because the totals are
   * what a bill and a disk are made of; the mean is `total / count` for anyone who wants it.
   */
  readonly totals: ReadonlyMap<string, number>;
  readonly durations: Durations;
}

export interface Inspector {
  /** Hand this to `mesh.onTelemetry`, `room.onTelemetry`, or both. */
  readonly note: TelemetryListener;
  /** Everything seen since the last reset, busiest first. */
  readonly stats: () => readonly TelemetryStats[];
  readonly of: (type: TelemetryEvent["type"]) => TelemetryStats | undefined;
  readonly reset: () => void;
  /** A few lines a person can read in a log or paste into an issue. */
  readonly report: () => string;
}

export interface InspectorOptions {
  /** Durations kept per type, for the percentiles. Default 256. */
  readonly keep?: number;
}

interface Seen {
  count: number;
  readonly totals: Map<string, number>;
  totalMs: number;
  maxMs: number;
  /** A ring of the most recent durations; `at` is where the next one goes. */
  readonly recent: number[];
  at: number;
}

/** The value at a rank of the sorted sample, nearest-rank, which needs no interpolation to explain. */
const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] ?? 0;
};

export function createInspector(options: InspectorOptions = {}): Inspector {
  const keep = Math.max(options.keep ?? 256, 1);
  const seen = new Map<TelemetryEvent["type"], Seen>();

  const statsOf = (type: TelemetryEvent["type"], held: Seen): TelemetryStats => {
    const sorted = [...held.recent].sort((x, y) => x - y);
    return {
      type,
      count: held.count,
      totals: held.totals,
      durations: {
        totalMs: held.totalMs,
        meanMs: held.count === 0 ? 0 : held.totalMs / held.count,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: held.maxMs,
      },
    };
  };

  return {
    note: (event) => {
      const held = seen.get(event.type) ?? {
        count: 0,
        totals: new Map<string, number>(),
        totalMs: 0,
        maxMs: 0,
        recent: [],
        at: 0,
      };
      held.count += 1;
      for (const [name, value] of Object.entries(event.sizes))
        held.totals.set(name, (held.totals.get(name) ?? 0) + value);
      const ms = event.duration.total({ unit: "milliseconds" });
      held.totalMs += ms;
      held.maxMs = Math.max(held.maxMs, ms);
      // a ring rather than a growing list: a long-running relay must not pay for its own uptime
      if (held.recent.length < keep) held.recent.push(ms);
      else held.recent[held.at] = ms;
      held.at = (held.at + 1) % keep;
      seen.set(event.type, held);
    },
    stats: () =>
      [...seen]
        .map(([type, held]) => statsOf(type, held))
        .sort((x, y) => y.count - x.count || (x.type < y.type ? -1 : 1)),
    of: (type) => {
      const held = seen.get(type);
      return held === undefined ? undefined : statsOf(type, held);
    },
    reset: () => seen.clear(),
    report: () => {
      const lines = [...seen]
        .map(([type, held]) => statsOf(type, held))
        .sort((x, y) => y.durations.totalMs - x.durations.totalMs || (x.type < y.type ? -1 : 1))
        .map((stat) => {
          const sizes = [...stat.totals]
            .map(([name, total]) => `${name}=${String(total)}`)
            .join(" ");
          const timing = `p50 ${stat.durations.p50Ms.toFixed(1)}ms p95 ${stat.durations.p95Ms.toFixed(1)}ms max ${stat.durations.maxMs.toFixed(1)}ms`;
          return `${stat.type} ×${String(stat.count)} ${timing}${sizes === "" ? "" : ` — ${sizes}`}`;
        });
      return lines.length === 0 ? "nothing has been reported yet" : lines.join("\n");
    },
  };
}

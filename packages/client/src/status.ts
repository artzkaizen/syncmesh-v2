import type { Transport, TransportCondition, TransportKind } from "@syncmesh/transport";

import type { RecoveryView } from "./recovery.js";

/**
 * Diagnosis, not a boolean (book ch. 18). A red dot tells a person nothing they can act on;
 * "Bluetooth is off — turn it on to sync with nearby devices" does, and that sentence needs a
 * per-source vocabulary rather than one aggregate flag.
 */

/** One medium, as a settings screen renders it. */
export interface SourceStatus {
  readonly kind: TransportKind;
  readonly condition: TransportCondition;
}

/**
 * How the mesh is doing overall, worst first. `auth-required` and `storage-degraded` are in the
 * book's vocabulary and deliberately absent here: nothing in the engine reports either yet, and
 * a health a UI cannot trust is worse than one word fewer.
 */
export type MeshHealth =
  /**
   * The client exists and its database does not yet — the first tens of milliseconds of every
   * launch, reported by the client rather than by this store, which only exists once it is over.
   */
  "opening" | "blocked-recovery" | "offline" | "catching-up" | "local-ready";

export interface MeshStatus {
  readonly health: MeshHealth;
  /**
   * Keyed by the transport's own name — its `id` — rather than by medium, because a fleet runs
   * two radios of one kind and the book's own examples name them (`ble({ id: "nearby" })`).
   * The medium rides in the value, so nothing is merged and nothing is lost.
   */
  readonly sources: ReadonlyMap<string, SourceStatus>;
}

export interface Status {
  readonly get: () => MeshStatus;
  /** Fires when a source changes state; the reading is cheap, so it hands back no snapshot. */
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * What a medium says about itself, or the most this can honestly infer: a transport that
 * declares a `condition` is believed, and one that only answers `onStatus` is `ok` while it is
 * up and `temporarily-unavailable` while it is not.
 */
const conditionOf = (transport: Transport, online: boolean | undefined): TransportCondition =>
  transport.condition?.() ?? (online === false ? "temporarily-unavailable" : "ok");

export interface StatusDeps {
  readonly transports: () => readonly Transport[];
  /** Whether each medium is up, as the runner's own subscription recorded it. */
  readonly online: (transport: Transport) => boolean | undefined;
  readonly recovery: RecoveryView;
  /** Every source that could still fill a scope has finished its first pass. */
  readonly settled: () => Promise<void>;
}

export function createStatus(deps: StatusDeps): Status {
  // one reading, taken once: `settled` is a promise, and a getter cannot await
  let caughtUp = false;
  void deps.settled().then(
    () => (caughtUp = true),
    () => undefined,
  );

  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  const health = (sources: ReadonlyMap<string, SourceStatus>): MeshHealth => {
    // an operator has to act: say so ahead of anything a reconnect would fix on its own
    if (deps.recovery.list().length > 0) return "blocked-recovery";
    const carrying = [...sources.values()].some((source) => source.condition === "ok");
    if (!carrying) return "offline";
    return caughtUp ? "local-ready" : "catching-up";
  };

  return {
    get: () => {
      const sources = new Map(
        deps.transports().map((transport) => [
          transport.name,
          {
            kind: transport.kind ?? "unknown",
            condition: conditionOf(transport, deps.online(transport)),
          },
        ]),
      );
      return { health: health(sources), sources };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      const offs = deps.transports().map((t) => t.onStatus?.(changed) ?? (() => undefined));
      return () => {
        listeners.delete(listener);
        for (const off of offs) off();
      };
    },
  };
}

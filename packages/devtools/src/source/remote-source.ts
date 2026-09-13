/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-shape-in-symbol-names -- the window's end of the inspector port: every answer arrives as `unknown` and the read it was asked for is the parse */

import type { RemoteInspect } from "@syncmesh/browser";
import type { SyncState } from "@syncmesh/client";
import type { RecentEvents, TelemetryStats, Unsubscribe } from "@syncmesh/engine";
import type { Result as ResultType } from "@syncmesh/result";

import { StoreFailure } from "@syncmesh/engine";

import type {
  DevtoolsChannel,
  DevtoolsGrants,
  DevtoolsIdentity,
  DevtoolsLinks,
  DevtoolsOverview,
  DevtoolsSchema,
  DevtoolsSource,
  DevtoolsStore,
  DevtoolsSql,
  DevtoolsSync,
  DevtoolsEvent,
  DevtoolsStranded,
  DevtoolsWrites,
  SqlRow,
} from "../contract.js";
import type { Opened, SnapshotName } from "./inspect-wire.js";

import { QueryFailed } from "../contract.js";
import { channelsFor, plain, revive, uncarry } from "./inspect-wire.js";

/**
 * The inspector's readings in a window that holds no engine.
 *
 * Every member of `DevtoolsSource` is here and means what it means on the leader, because what
 * crosses is **the leader's own source** — one `createMeshSource` for the origin, read by however
 * many windows have a panel open. There is no second inspector, no second telemetry listener and
 * no second count of anything.
 *
 * Two things follow from a port that a reader should know about.
 *
 * **The snapshots are cached and the cache is one round trip behind a change.** The contract's
 * seven snapshot readers answer synchronously and a port cannot, so this keeps the last reading of
 * each, re-asks for the ones some panel has actually drawn when the host says a channel moved, and
 * announces the change *after* the answers land — so a panel repaints once per burst with data
 * that agrees with itself. A reader nothing has drawn is never fetched, which is what keeps
 * `timings()` off the wire in a window whose panels do not show it.
 *
 * **`overview().handles` counts the leader's handles, not this window's.** It is the one field
 * here whose subject is a thread rather than the device: live queries opened in *this* tab are
 * this tab's, and they are not in that tally. The leak check it exists for still works — it is
 * just a leak check for the tab holding the engine.
 *
 * What is deliberately **not** served is the Writes panel's two optional extras. `receiptsOf` and
 * `corrections` reach `mesh.internal`, which is the engine's own door and is not on this port; a
 * window renders the sentence it renders for any absent capability rather than an empty custody
 * list that would read as *nobody holds this write*.
 */

/** What a window needs to build one: the inspector door, and the mesh's own cached `syncOf`. */
export interface RemoteSourceMesh {
  readonly inspect: RemoteInspect;
  readonly syncOf: (table: string, key: string) => SyncState | undefined;
}

const lost = (message: string) => (cause: unknown) => new StoreFailure({ message, cause });

const HOST_GONE = "the tab holding this mesh stopped answering, so nothing could be read from it";

export async function createRemoteSource(mesh: RemoteSourceMesh): Promise<DevtoolsSource> {
  const { inspect } = mesh;
  const cache = new Map<SnapshotName, unknown>();
  const fetched = new Map<SnapshotName, number>();
  const hot = new Set<SnapshotName>();
  const listeners = new Set<(moved: ReadonlySet<DevtoolsChannel>) => void>();
  const pending = new Set<DevtoolsChannel>();
  let stamp = 0;
  let flight = false;
  let dirty = false;
  let scheduled = false;
  let closed = false;

  const absorb = (taken: unknown, at: number): void => {
    for (const [name, value] of Object.entries(taken as Record<string, unknown>)) {
      cache.set(name as SnapshotName, revive(value));
      fetched.set(name as SnapshotName, at);
    }
  };

  const stale = (): readonly SnapshotName[] =>
    [...hot].filter((name) => (fetched.get(name) ?? -1) < stamp);

  /**
   * Tells the panels, once, with everything that moved since the last time.
   *
   * A refresh that nothing asked for — a panel drew a reader for the first time after a change
   * had already been announced — re-announces the channels those readers speak for, so the panel
   * that read a stale value is told to read it again. Exactly once: the second read is current.
   */
  const flush = (names: readonly SnapshotName[]): void => {
    const moved = pending.size > 0 ? new Set(pending) : channelsFor(names);
    pending.clear();
    if (moved.size === 0) return;
    for (const listener of listeners) listener(moved);
  };

  const refresh = (): void => {
    if (closed) return;
    if (flight) {
      dirty = true;
      return;
    }
    const wanted = stale();
    if (wanted.length === 0) {
      flush(wanted);
      return;
    }
    flight = true;
    const at = stamp;
    void inspect.read("snapshot", [wanted]).then(
      (taken) => {
        flight = false;
        absorb(taken, at);
        flush(wanted);
        if (!dirty) return;
        dirty = false;
        refresh();
      },
      () => {
        flight = false;
        flush(wanted);
      },
    );
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      refresh();
    });
  };

  /** A cached reading, and a note that some panel draws it — which is what puts it on the wire. */
  const read = <T>(name: SnapshotName): T => {
    hot.add(name);
    if ((fetched.get(name) ?? -1) < stamp) schedule();
    // SAFETY: the prime filled every name in `SNAPSHOTS`, and each carries its own reader's answer
    return cache.get(name) as T;
  };

  // watching first, then priming: the host opens its source when a window subscribes, and a read
  // that arrived in front of that subscription would be refused for want of one
  const off = inspect.watch((moved) => {
    stamp += 1;
    // SAFETY: the host broadcasts the channel set its own source emitted, as an array
    for (const channel of moved as DevtoolsChannel[]) pending.add(channel);
    refresh();
  });
  const opened = (await inspect.read("open")) as Opened;
  absorb(opened.snapshot, stamp);
  const served = opened.served;

  const asked = async <T, E extends StoreFailure | QueryFailed>(
    name: string,
    args: readonly unknown[],
    whenLost: (cause: unknown) => E,
  ): Promise<ResultType<T, E>> => {
    const answer = await inspect.read(name, args).catch((cause: unknown) => ({
      ok: false as const,
      error: { _tag: "@lost", cause },
    }));
    return uncarry<T, E>(answer, whenLost);
  };

  const sql: DevtoolsSql = {
    query: (statement, params) =>
      asked<readonly SqlRow[], QueryFailed>(
        "sql",
        [statement, params ?? null],
        (cause) => new QueryFailed({ sql: statement, cause }),
      ),
  };

  return {
    identity: () => read<DevtoolsIdentity>("identity"),
    overview: () => read<DevtoolsOverview>("overview"),
    sync: () => read<DevtoolsSync>("sync"),
    links: () => read<DevtoolsLinks>("links"),
    schema: () => read<DevtoolsSchema>("schema"),
    grants: () => read<DevtoolsGrants>("grants"),
    timings: () => read<readonly TelemetryStats[]>("timings"),
    events: (recent?: RecentEvents) =>
      asked<readonly DevtoolsEvent[], StoreFailure>(
        "events",
        [plain(recent ?? null)],
        lost(HOST_GONE),
      ),
    storage: served.storage
      ? () =>
          asked<DevtoolsStore, QueryFailed>(
            "storage",
            [],
            (cause) => new QueryFailed({ sql: "storage", cause }),
          )
      : undefined,
    writes: served.writes
      ? (limit: number) => asked<DevtoolsWrites, StoreFailure>("writes", [limit], lost(HOST_GONE))
      : undefined,
    stranded: () =>
      asked<readonly DevtoolsStranded[], StoreFailure>("stranded", [], lost(HOST_GONE)),
    sql: served.sql ? sql : undefined,
    syncOf: (table, key) => mesh.syncOf(table, key),
    onChange: (listener): Unsubscribe => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /**
     * Lets go of the port's topic, which is what releases the origin's source when the last
     * window closes. The last readings are **kept**: a panel can render one more frame after the
     * shell drops the source, and a reader that answered `undefined` there would take the panel
     * down with a `TypeError` rather than drawing what it last knew. What matters is the
     * subscription, and that is gone.
     */
    close: () => {
      if (closed) return;
      closed = true;
      off();
      listeners.clear();
      hot.clear();
    },
  };
}

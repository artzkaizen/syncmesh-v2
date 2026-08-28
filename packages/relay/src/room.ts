import type {
  EventStore,
  StoreFailure,
  StoredEvent,
  TelemetryEvent,
  TelemetryListener,
} from "@syncmesh/engine";
import type { PeerId, SyncEvent } from "@syncmesh/kernel";
import type { BlobStore } from "@syncmesh/storage";

import { createHub, trackCoverage, type Unsubscribe } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { createPresenceStore } from "@syncmesh/transport";

import type { RelayConnection } from "./connection.js";
import type { Fanout } from "./fanout.js";
import type { RelayLimits } from "./limits.js";
import type { RelaySocket } from "./sender.js";
import type { Client, RoomState } from "./state.js";

import { createConnection } from "./connection.js";
import { RELAY_PROTOCOL_VERSIONS, kaFrame } from "./frames.js";
import { createGrantCache } from "./grant-cache.js";
import { DEFAULT_LIMITS } from "./limits.js";

export type { RelayConnection } from "./connection.js";

export interface RelayRoomOptions {
  readonly name: string;
  /** The durable room log — the same port the engine persists through (RFC-0004). */
  readonly store: EventStore;
  /** The log's lineage id: persisted with it, sent in every `hello`. A new log is a new epoch. */
  readonly epoch: string;
  /** Cadence of `ka` frames; the client's liveness deadline is 2.5× this. Default 15000. */
  readonly keepaliveMs?: number;
  /** Events per catch-up frame. One frame is not a transfer, it is a cliff (RFC-0010). Default 2000. */
  readonly pageSize?: number;
  /** Queued frames per socket before the relay hangs up. Default 1000. */
  readonly maxBacklog?: number;
  /**
   * Protocol versions this room accepts (D14). Narrowing it is how an operator raises the floor:
   * a client offering only what is no longer on the list gets a typed `version` error and a close,
   * never a mid-stream decode failure.
   */
  readonly versions?: readonly number[];
  /**
   * Per-socket ceilings; each half defaults from `DEFAULT_LIMITS`. `rates` is all-or-nothing —
   * a partly-overridden rate table is a table where the class nobody thought about is the one
   * left wide open.
   */
  readonly limits?: Partial<RelayLimits>;
  readonly fanout?: Fanout;
  /**
   * Where this room's blobs live (D18): the relay is their durable home, which is what lets a
   * device treat what it fetched as a cache it may evict. Absent, the room serves no bytes.
   */
  readonly blobs?: BlobStore;
  /** The room's clock, for rate limiting and presence expiry. Default the wall clock. */
  readonly now?: () => Temporal.Instant;
  /**
   * A telemetry listener from the first frame on. `onTelemetry` on the room subscribes just as
   * well, but a host that opens rooms lazily has no handle to subscribe through before the first
   * socket has already been served (D17).
   */
  readonly onTelemetry?: TelemetryListener;
}

/**
 * One room: store-and-forward of signed bytes by a process that holds no keys. It verifies
 * shapes and signatures, appends, acks and forwards — it interprets nothing, so a compromised
 * relay can drop traffic but cannot forge it.
 */
export interface RelayRoom {
  readonly connect: (socket: RelaySocket) => RelayConnection;
  /** Appends to this room's log since it was opened, continued across restarts. */
  readonly offset: () => number;
  readonly clients: () => number;
  /**
   * D17's seam, over the same union the engine and the mesh emit, so one `switch` covers all
   * three. Every `relay.*` variant is anonymous by construction: sizes and durations, never a
   * peer id, a room name or a byte of payload.
   */
  readonly onTelemetry: (listener: TelemetryListener) => Unsubscribe;
  readonly close: () => void;
}

export async function openRelayRoom(
  options: RelayRoomOptions,
): Promise<Result<RelayRoom, StoreFailure>> {
  const { name, store, epoch, blobs, keepaliveMs = 15_000, pageSize = 2000 } = options;
  const maxBacklog = options.maxBacklog ?? 1000;
  const now = options.now ?? (() => Temporal.Now.instant());
  const boot = await store.all();
  if (boot.isErr()) return boot;

  /**
   * What catch-up can actually hand over: a synced entry whose author's signature was stored. An
   * entry without one is dropped by `paged`, and a local one is out of `allSince`'s scope — so
   * counting either into the room's position would advertise a place the room can never serve
   * from. Any log the relay did not fill itself holds both (`StartRelayOptions.store`).
   */
  const servable = (entry: StoredEvent): boolean =>
    entry.sig !== undefined && entry.event.local !== true;
  // contiguous, and over the same entries: a MAX cursor over a hole is a claim the room cannot
  // take back, because every client asks for what is *above* the number it was given
  const coverage = trackCoverage();
  for (const entry of boot.value) if (servable(entry)) coverage.note(entry.event);
  const cursors = () => coverage.current().synced;
  let offset = boot.value.length;

  /** One grant per device, newest mint wins, so a revocation retires what it replaces. */
  const grants = createGrantCache();
  /**
   * The ephemeral tier at the middle hop (D16): last value per topic, instance and peer, so a
   * joiner learns who is here without any history and a slow client is never sent a backlog.
   */
  const presence = createPresenceStore();
  const clients = new Map<PeerId, Client>();
  /** Room-serialized async work: offsets and acks stay ordered. */
  let queue: Promise<unknown> = Promise.resolve();
  // a listener that throws is dropped here and nowhere else: an observer must never be able to
  // stop a relay forwarding bytes, and the relay has no error channel to report it down
  const telemetry = createHub<TelemetryEvent>(() => undefined);
  if (options.onTelemetry !== undefined) telemetry.subscribe(options.onTelemetry);

  const toClients = (frame: Uint8Array, except?: PeerId): void => {
    for (const client of clients.values()) {
      if (client.peer !== except) client.sender.send(frame);
    }
  };
  const toInterested = (frame: Uint8Array, event: SyncEvent, except?: PeerId): number => {
    let receivers = 0;
    for (const client of clients.values()) {
      if (client.peer !== except && client.wants(event)) {
        client.sender.send(frame);
        receivers += 1;
      }
    }
    return receivers;
  };
  const fan = options.fanout?.connect(name);
  const offFan = fan?.onFrame((frame) => toClients(frame));
  const keepalive = setInterval(() => toClients(kaFrame()), keepaliveMs);

  const state: RoomState = {
    store,
    epoch,
    keepaliveMs,
    pageSize,
    maxBacklog,
    versions: options.versions ?? RELAY_PROTOCOL_VERSIONS,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    blobs,
    grants,
    presence,
    clients,
    cursors,
    toClients,
    toInterested,
    publish: (frame) => fan?.publish(frame),
    offset: () => offset,
    appended: (entry) => {
      offset += 1;
      if (servable(entry)) coverage.note(entry.event);
    },
    enqueue: (work) => void (queue = queue.then(work)),
    now,
    report: telemetry.emit,
  };

  return Result.ok({
    connect: (socket) => createConnection(socket, state),
    offset: () => offset,
    clients: () => clients.size,
    onTelemetry: telemetry.subscribe,
    close: () => {
      clearInterval(keepalive);
      offFan?.();
      fan?.close();
      for (const client of clients.values()) client.socket.close("room closed");
      clients.clear();
    },
  });
}

import type {
  Cursors,
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
import { isRelayable } from "@syncmesh/wire";

import type { ConnectionOptions, RelayConnection } from "./connection.js";
import type { Fanout } from "./fanout.js";
import type { GrantCache } from "./grant-cache.js";
import type { RelayLimits } from "./limits.js";
import type { RelayRetention } from "./retention.js";
import type { RelaySocket } from "./sender.js";
import type { Client, RoomState } from "./state.js";

import { createConnection } from "./connection.js";
import { fanIn } from "./fan-in.js";
import { RELAY_PROTOCOL_VERSIONS, kaFrame } from "./frames.js";
import { createGrantCache } from "./grant-cache.js";
import { DEFAULT_LIMITS } from "./limits.js";
import { roomRetention } from "./retention.js";

export type { ConnectionOptions, RelayConnection } from "./connection.js";

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
  /**
   * What this room stops keeping. Absent, it keeps everything, which is what it did before
   * the option existed — a cap that trims history is one an operator has to ask for.
   */
  readonly retention?: RelayRetention;
  /**
   * The grant cache to carry on with, for a host that closes idle rooms and re-opens them. It is
   * the one thing a re-join does **not** rebuild: a device sends its grants once, straight after
   * joining, so a room re-opened with a fresh cache holds the grants of exactly the devices that
   * are connected right now and none of the ones that left — and the next joiner is paged a
   * catch-up it cannot validate. Absent, the room starts with an empty one.
   */
  readonly grants?: GrantCache;
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
  readonly connect: (socket: RelaySocket, options?: ConnectionOptions) => RelayConnection;
  /**
   * Entries this room's log holds, counted up from what was there when it opened. A retention
   * sweep does not move it back down, so a restart after one starts lower than the number the
   * last run finished on. Nothing folds it: it rides on `ack`, `page` and `relayed` for a human
   * reading a trace, and no client's cursor or state is derived from it.
   */
  readonly offset: () => number;
  readonly clients: () => number;
  /**
   * Per author, the highest sequence retention has taken away — the bottom of what catch-up can
   * serve, as `hello` advertises it. Empty until something is actually trimmed.
   */
  readonly floor: () => Cursors;
  /**
   * One retention pass now, rather than at the room's own cadence. The room sweeps on a timer
   * whenever `keepEventsFor` is set; this is the same pass, for a host whose scheduler is the
   * platform's (a Durable Object alarm) and for a test that will not wait a minute.
   */
  readonly sweep: () => Promise<void>;
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
  const { name, store, epoch, keepaliveMs = 15_000, pageSize = 2000 } = options;
  const maxBacklog = options.maxBacklog ?? 1000;
  const now = options.now ?? (() => Temporal.Now.instant());
  const boot = await store.all();
  if (boot.isErr()) return boot;
  // read before the log is walked, because it is what the walk starts from: a log already trimmed
  // holds no entry below the floor, and a coverage seeded at zero would find every author's run
  // beginning past a gap and advertise nothing at all
  const trimmed = await store.compactedBelow();
  if (trimmed.isErr()) return Result.err(trimmed.error);

  /**
   * What catch-up can actually hand over: a synced entry whose author's signature was stored. An
   * entry without one is dropped by `paged`, and a local one is out of `allSince`'s scope — so
   * counting either into the room's position would advertise a place the room can never serve
   * from. Any log the relay did not fill itself holds both (`StartRelayOptions.store`).
   */
  const servable = (entry: StoredEvent): boolean =>
    isRelayable(entry) && entry.event.local !== true;
  // contiguous, and over the same entries: a MAX cursor over a hole is a claim the room cannot
  // take back, because every client asks for what is *above* the number it was given
  const coverage = trackCoverage(trimmed.value);
  for (const entry of boot.value) if (servable(entry)) coverage.note(entry.event);
  const cursors = () => coverage.current().synced;
  let offset = boot.value.length;

  /** One grant per device, newest mint wins, so a revocation retires what it replaces. */
  const grants = options.grants ?? createGrantCache();
  /**
   * The ephemeral tier at the middle hop (D16): last value per topic, instance and peer, so a
   * joiner learns who is here without any history and a slow client is never sent a backlog.
   */
  const presence = createPresenceStore();
  const clients = new Map<PeerId, Client>();
  /** Room-serialized async work: offsets and acks stay ordered. */
  let queue: Promise<unknown> = Promise.resolve();
  const retention = roomRetention({
    store,
    policy: options.retention,
    blobs: options.blobs,
    ceiling: () => coverage.current().synced,
    booted: trimmed.value.synced,
    now,
    // caught rather than left on the queue: a rejected `queue` is a room that silently stops
    // appending, and a retention pass must never be able to do that to the traffic beside it
    serialize: (work) => {
      const next = queue.then(work).catch(() => undefined);
      queue = next;
      return next;
    },
  });
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
  const keepalive = setInterval(() => toClients(kaFrame()), keepaliveMs);

  const state: RoomState = {
    store,
    epoch,
    keepaliveMs,
    pageSize,
    maxBacklog,
    versions: options.versions ?? RELAY_PROTOCOL_VERSIONS,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    blobs: retention.blobs,
    grants,
    presence,
    clients,
    cursors,
    floor: retention.floor,
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
  // subscribed after the state exists, because a fanned-in frame is ingested through it
  const offFan = fan?.onFrame(fanIn(state));

  // said once, at open, and never again: which rooms grow forever is a thing an operator should
  // learn from a dashboard rather than from a disk alert (gap audit №8)
  if (retention.unbounded)
    telemetry.emit({
      type: "relay.retention.unbounded",
      sizes: { blobBytes: retention.blobCeiling },
      duration: Temporal.Duration.from({ seconds: 0 }),
    });

  return Result.ok({
    connect: (socket, options) => createConnection(socket, state, options),
    offset: () => offset,
    clients: () => clients.size,
    floor: retention.floor,
    sweep: retention.sweep,
    onTelemetry: telemetry.subscribe,
    close: () => {
      clearInterval(keepalive);
      retention.stop();
      offFan?.();
      fan?.close();
      for (const client of clients.values()) client.socket.close("room closed");
      clients.clear();
    },
  });
}

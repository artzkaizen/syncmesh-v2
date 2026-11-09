import type {
  Cursors,
  EventStore,
  StoreFailure,
  StoredEvent,
  TelemetryEvent,
  TelemetryListener,
} from "@syncmesh/engine";
import type { PeerId, SyncEvent } from "@syncmesh/kernel";
import type { BlobHomes, BlobLedger, BlobStore } from "@syncmesh/storage";

import { createHub, heldRuns, trackCoverage, type Unsubscribe } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { createPresenceStore } from "@syncmesh/transport";
import { createIdentity, isRelayable, randomBytes, type Identity } from "@syncmesh/wire";

import type { RelayAdmission } from "./admission.js";
import type { ConnectionOptions, RelayConnection } from "./connection.js";
import type { Fanout, FanoutLink } from "./fanout.js";
import type { GrantCache } from "./grant-cache.js";
import type { RelayLimits } from "./limits.js";
import type { RelayRetention } from "./retention.js";
import type { RoomCustodyOptions } from "./room-receipts.js";
import type { RelaySocket } from "./sender.js";
import type { Client, Fanned, RoomState } from "./state.js";
import type { RoomTrust } from "./trust.js";

import { createGate } from "./admission.js";
import { createConnection } from "./connection.js";
import { fanIn } from "./fan-in.js";
import { HANDSHAKE_VERSION, RELAY_PROTOCOL_VERSIONS, kaFrame, speaksHandshake } from "./frames.js";
import { createGrantCache } from "./grant-cache.js";
import { DEFAULT_LIMITS, createBudget } from "./limits.js";
import { roomRetention } from "./retention.js";
import { assertTruthfulCustody, createRoomReceipts } from "./room-receipts.js";

export type { ConnectionOptions, RelayConnection } from "./connection.js";

export interface RelayRoomOptions {
  readonly name: string;
  /** The durable room log — the same port the engine persists through (RFC-0004). */
  readonly store: EventStore;
  /** The log's lineage id: persisted with it, sent in every `hello`. A new log is a new epoch. */
  readonly epoch: string;
  /**
   * Whether `store` outlives this process — a file, a Durable Object's SQLite, a database (D42).
   * Every `hello` says so, and only a room that does has its acks counted by `mesh.synced()`.
   * Default `false`: a log in memory acks as promptly as one on disk, and a restart loses it.
   */
  readonly durable?: boolean;
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
   * The key this room signs its link hello with (D36). Absent, a fresh one per open — the link
   * is then confidential against everyone but the relay itself, which is what it is for, and a
   * client pins nothing. Given, the room has a name a client could pin one day; a host with a
   * durable store keeps one beside the epoch for exactly that reason.
   */
  readonly identity?: Identity;
  /**
   * Signs this room's own custody (D28, U38): what the log holds of each author's writes, as a
   * `CustodyReceipt` under `identity` with `epoch` as the incarnation, sent to that author's
   * socket when it sits down and within `every` of its writes landing. The author's ledger then
   * counts the room as a holder, so `soleCustody()` stops listing what the room keeps and a
   * device can detach a partition the room holds for it.
   *
   * A receipt licenses a deletion on the author's device, so the room signs only what is true for
   * as long as the key names it, and throws at open on a definition that could not be:
   * - `identity` must be given, and must outlive the log. A key minted per process, or kept in the
   *   same file as the log, comes back as a different holder after the log is lost, and what the
   *   old key signed is never withdrawn — the epoch can only retire what its own key signed.
   * - `durable` must be true: a log in memory is gone on restart, and its receipts with it.
   * - `retention.keepEventsFor` must be absent: a receipt says "everything through N", and a room
   *   that trims holds only the end of that. A log trimmed before this open is not refused, but an
   *   author whose events compaction removed is never signed for: the room signs its held run,
   *   which starts below the floor and never closes over it.
   *
   * Absent, the room signs nothing, as every room did before.
   */
  readonly custody?: RoomCustodyOptions;
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
   * Where each of those blobs may be read (D44): the partitions its puts were billed to, which a
   * grant-gated room checks a fetch against. Kept beside the bytes by every durable host; absent,
   * the room keeps them in memory, and after a restart a gated room answers `blob-missing` for
   * bytes put before it until somebody holding them puts them again.
   */
  readonly blobHomes?: BlobHomes;
  /**
   * What the rows this room has seen referenced (gaps U18), kept beside the bytes by every durable
   * host so a trim of the log or a restart forgets none of it. Absent, the room keeps it in
   * memory, which holds for as long as its log has never been trimmed.
   */
  readonly blobLedger?: BlobLedger;
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
  /**
   * The issuers whose grants admit a device, which makes this a grant-gated room (D40): a joiner
   * is seated only under a grant one of them signed, and is served only the partitions it names.
   * Absent, the room is open — whoever knows its name reads all of it.
   */
  readonly trust?: RoomTrust;
  /** The room's clock, for rate limiting and presence expiry. Default the wall clock. */
  readonly now?: () => Temporal.Instant;
  /**
   * The authority-visibility gate (D24-A): which tables are gated and what each device is
   * entitled to read of them. Applied to catch-up and to every live fan-out, the one from another
   * instance included. Absent, the room withholds nothing a device did not narrow away itself.
   */
  readonly admission?: RelayAdmission;
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
  /** The log's lineage id, as every `hello` announces it; a describe over HTTP reports the same one. */
  readonly epoch: string;
  /**
   * The key this room signs its link hello with (D36) — the one a client pins with `relayKey`, and
   * the one a describe reports. The host's key unless the room's store supplied its own.
   */
  readonly peerId: PeerId;
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
   * whenever `keepEventsFor` or `keepUnreferencedBlobsFor` is set; this is the same pass, for a host whose scheduler is the
   * platform's (a Durable Object alarm) and for a test that will not wait a minute.
   */
  readonly sweep: () => Promise<void>;
  /**
   * D17's seam, over the same union the engine and the mesh emit, so one `switch` covers all
   * three. Every `relay.*` variant is anonymous by construction: sizes and durations, never a
   * peer id, a room name or a byte of payload.
   */
  readonly onTelemetry: (listener: TelemetryListener) => Unsubscribe;
  /**
   * The authority's answer for these devices has changed — a clinic membership, a consult window
   * (D24). Their sockets are closed, and the join each makes next is asked again; a device whose
   * entitlement's name moved re-pages from nothing, so nothing it was refused before stays skipped.
   */
  readonly reentitle: (peers: readonly PeerId[]) => void;
  readonly close: () => void;
}

export async function openRelayRoom(
  options: RelayRoomOptions,
): Promise<Result<RelayRoom, StoreFailure>> {
  const { name, store, epoch, keepaliveMs = 15_000, pageSize = 2000 } = options;
  const maxBacklog = options.maxBacklog ?? 1000;
  const now = options.now ?? (() => Temporal.Now.instant());
  const versions = roomVersions(options.versions);
  const identity = roomIdentity(options.identity);
  assertTruthfulCustody(options.custody, options, `relay room ${name}`);
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
  // the held run starts empty, not at the floor: what compaction removed is advertised (nobody is
  // sent it again) but not held, so the run the room signs (U38) never closes over a trimmed author
  const coverage = trackCoverage({ ...trimmed.value, held: new Map() });
  for (const entry of boot.value) if (servable(entry)) coverage.note(entry.event);
  const cursors = () => coverage.current().synced;
  const held = () => heldRuns(coverage.current());
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
  const telemetry = roomTelemetry(options.onTelemetry);
  const retained = await roomRetention({
    store,
    policy: options.retention,
    blobs: options.blobs,
    homes: options.blobHomes,
    ledger: options.blobLedger,
    report: telemetry.emit,
    ceiling: () => coverage.current().synced,
    booted: trimmed.value.synced,
    held: boot.value,
    now,
    // caught rather than left on the queue: a rejected `queue` is a room that silently stops
    // appending, and a retention pass must never be able to do that to the traffic beside it
    serialize: (work) => {
      const next = queue.then(work).catch(() => undefined);
      queue = next;
      return next;
    },
  });
  if (retained.isErr()) return Result.err(retained.error);
  const retention = retained.value;

  const toClients = (frame: Uint8Array, except?: PeerId): void => {
    for (const client of clients.values()) {
      if (client.peer !== except) client.sender.send(frame);
    }
  };
  const toClientsLatest = (slot: string | undefined, frame: Uint8Array, except?: PeerId): void => {
    for (const client of clients.values()) {
      if (client.peer !== except) client.sender.sendLatest(slot, frame);
    }
  };
  const toInterested = (frame: Uint8Array, event: SyncEvent, except?: PeerId): Fanned => {
    let receivers = 0;
    let frames = 0;
    for (const client of clients.values()) {
      if (client.peer === except) continue;
      const offered = client.offer(frame, event);
      if (offered.sent) receivers += 1;
      frames += offered.frames;
    }
    return { receivers, frames };
  };
  const fan = options.fanout?.connect(name);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  // the same bucket a socket spends from, priced at the room's rate rather than one socket's
  const budget = createBudget(
    { ...limits, rates: { ...limits.rates, fanout: limits.roomFanout } },
    now,
  );
  const keepalive = setInterval(() => toClients(kaFrame()), keepaliveMs);
  const receipts =
    options.custody === undefined
      ? undefined
      : createRoomReceipts({ clients, held, identity, epoch, now }, options.custody);

  const state: RoomState = {
    store,
    epoch,
    durable: options.durable === true,
    keepaliveMs,
    pageSize,
    maxBacklog,
    versions,
    identity,
    receipts,
    limits,
    budget,
    blobs: retention.blobs,
    keeper: retention.keeper,
    grants,
    trust: options.trust,
    presence,
    clients,
    held: new Set(),
    cursors,
    floor: retention.floor,
    toClients,
    toClientsLatest,
    toInterested,
    publish: (frame) => fan?.publish(frame),
    offset: () => offset,
    appended: (entry) => {
      offset += 1;
      retention.keeper?.note(entry.event);
      if (!servable(entry)) return;
      coverage.note(entry.event);
      receipts?.appended(entry.event.peerId);
    },
    enqueue: (work) => void (queue = queue.then(work)),
    now,
    report: telemetry.emit,
    gate: options.admission === undefined ? undefined : createGate(options.admission, name),
  };
  // subscribed after the state exists, because a fanned-in frame is ingested through it
  const offFan = await hearFleet(fan, fanIn(state));

  // said once, at open, and never again: which rooms grow forever is a thing an operator should
  // learn from a dashboard rather than from a disk alert (gap audit №8)
  if (retention.unbounded)
    telemetry.emit({
      type: "relay.retention.unbounded",
      sizes: { blobBytes: retention.blobCeiling },
      duration: Temporal.Duration.from({ seconds: 0 }),
    });

  return Result.ok({
    epoch,
    peerId: identity.peerId,
    connect: (socket, options) => createConnection(socket, state, options),
    offset: () => offset,
    clients: () => clients.size,
    floor: retention.floor,
    sweep: retention.sweep,
    onTelemetry: telemetry.subscribe,
    reentitle: (peers) => {
      for (const peer of peers) clients.get(peer)?.socket.close("entitlement changed");
    },
    close: () => {
      clearInterval(keepalive);
      receipts?.close();
      retention.stop();
      offFan?.();
      fan?.close();
      for (const client of clients.values()) client.socket.close("room closed");
      clients.clear();
    },
  });
}

/**
 * Subscribes the room to the rest of the fleet, and waits until it hears it: a room served before
 * then would miss what another instance publishes meanwhile (gaps U41).
 */
async function hearFleet(
  fan: FanoutLink | undefined,
  deliver: (frame: Uint8Array) => void,
): Promise<(() => void) | undefined> {
  if (fan === undefined) return undefined;
  const off = fan.onFrame(deliver);
  await fan.heard?.();
  return off;
}

/**
 * The versions a room offers, `RELAY_PROTOCOL_VERSIONS` when it names none. Throws on a list that
 * mixes {@link HANDSHAKE_VERSION} with an older version: a definition mistake, since a room speaks
 * a hello first or a challenge first and one socket cannot be told both.
 */
function roomVersions(listed: readonly number[] | undefined): readonly number[] {
  const versions = listed ?? RELAY_PROTOCOL_VERSIONS;
  if (speaksHandshake(versions) && versions.some((v) => v !== HANDSHAKE_VERSION))
    throw new Error(
      `a relay room lists ${HANDSHAKE_VERSION} alone or leaves it out: the link handshake and the challenge cannot share one socket (got ${versions.join(", ")})`,
    );
  return versions;
}

/**
 * The room's telemetry hub, with the host's listener on it from the first event. A listener that
 * throws is dropped here and nowhere else: an observer must never be able to stop a relay
 * forwarding bytes, and the relay has no error channel to report it down.
 */
function roomTelemetry(listener: TelemetryListener | undefined) {
  const telemetry = createHub<TelemetryEvent>(() => undefined);
  if (listener !== undefined) telemetry.subscribe(listener);
  return telemetry;
}

/** The room's identity: the one it was given, or a fresh one. Throws when one cannot be made. */
function roomIdentity(given: Identity | undefined): Identity {
  if (given !== undefined) return given;
  return createIdentity(randomBytes(32)).match({
    ok: (value) => value,
    err: (failure) => {
      throw new Error(`the room's identity could not be made: ${failure.message}`);
    },
  });
}

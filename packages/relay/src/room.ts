import type { EventStore, StoreFailure } from "@syncmesh/engine";
import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";
import type { BlobStore } from "@syncmesh/storage";

import { Result } from "@syncmesh/result";
import { createPresenceStore } from "@syncmesh/transport";

import type { Client, RelayConnection, RoomState } from "./connection.js";
import type { Fanout } from "./fanout.js";
import type { RelaySocket } from "./sender.js";

import { createConnection } from "./connection.js";
import { kaFrame } from "./frames.js";

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
  readonly fanout?: Fanout;
  /**
   * Where this room's blobs live (D18): the relay is their durable home, which is what lets a
   * device treat what it fetched as a cache it may evict. Absent, the room serves no bytes.
   */
  readonly blobs?: BlobStore;
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
  readonly close: () => void;
}

export async function openRelayRoom(
  options: RelayRoomOptions,
): Promise<Result<RelayRoom, StoreFailure>> {
  const { name, store, epoch, blobs, keepaliveMs = 15_000, pageSize = 2000 } = options;
  const maxBacklog = options.maxBacklog ?? 1000;
  const boot = await store.all();
  if (boot.isErr()) return boot;

  const cursors = new Map<PeerId, SeqNum>();
  const advance = (peer: PeerId, seq: SeqNum): void => {
    if (Number(cursors.get(peer) ?? 0) < Number(seq)) cursors.set(peer, seq);
  };
  for (const { event } of boot.value) advance(event.peerId, event.seqNum);
  let offset = boot.value.length;

  const grants = new Map<string, Uint8Array>();
  /**
   * The ephemeral tier at the middle hop (D16): last value per topic, instance and peer, so a
   * joiner learns who is here without any history and a slow client is never sent a backlog.
   */
  const presence = createPresenceStore();
  const clients = new Map<PeerId, Client>();
  /** Room-serialized async work: offsets and acks stay ordered. */
  let queue: Promise<unknown> = Promise.resolve();

  const toClients = (frame: Uint8Array, except?: PeerId): void => {
    for (const client of clients.values()) {
      if (client.peer !== except) client.sender.send(frame);
    }
  };
  const toInterested = (frame: Uint8Array, event: SyncEvent, except?: PeerId): void => {
    for (const client of clients.values()) {
      if (client.peer !== except && client.wants(event)) client.sender.send(frame);
    }
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
    blobs,
    grants,
    presence,
    clients,
    cursors,
    toClients,
    toInterested,
    publish: (frame) => fan?.publish(frame),
    offset: () => offset,
    appended: (peer, seq) => {
      offset += 1;
      advance(peer, seq);
    },
    enqueue: (work) => void (queue = queue.then(work)),
  };

  return Result.ok({
    connect: (socket) => createConnection(socket, state),
    offset: () => offset,
    clients: () => clients.size,
    close: () => {
      clearInterval(keepalive);
      offFan?.();
      fan?.close();
      for (const client of clients.values()) client.socket.close("room closed");
      clients.clear();
    },
  });
}

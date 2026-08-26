import type { EventStore, StoreFailure, StoredEvent } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { createPresenceStore, cursorsFrame, presenceFrame } from "@syncmesh/transport";
import {
  bytesToHex,
  decodeAndVerify,
  decodeAndVerifyPresence,
  encodeCbor,
  encodeEventCore,
} from "@syncmesh/wire";

import type { Fanout } from "./fanout.js";
import type { RelaySocket, Sender } from "./sender.js";

import {
  RELAY_PROTOCOL_VERSIONS,
  ackFrame,
  decodeRelayFrame,
  errorFrame,
  helloFrame,
  kaFrame,
  pageFrame,
  relayedFrame,
} from "./frames.js";
import { createSender } from "./sender.js";

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
}

/** What the host wires each accepted socket to. */
export interface RelayConnection {
  readonly receive: (bytes: Uint8Array) => void;
  /** The host's socket buffer drained: flush this connection's backlog in order. */
  readonly drain: () => void;
  /** The socket is gone; the host must call this exactly once. */
  readonly closed: () => void;
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

interface Client {
  readonly peer: PeerId;
  readonly sender: Sender;
  readonly socket: RelaySocket;
}

/** A stored event back to wire form; `undefined` for an entry whose signature was never stored. */
const envelopeOf = (entry: StoredEvent): Uint8Array | undefined =>
  entry.sig === undefined ? undefined : encodeCbor([encodeEventCore(entry.event), entry.sig]);

/**
 * A joiner's history as frames: `pageSize` events each, grants on the first, and always at least
 * one page — its `more: false` is what releases the client's push-outstanding, so a client that
 * is already caught up still gets told so. One frame is not a transfer, it is a cliff (RFC-0010).
 */
function paged(
  entries: readonly StoredEvent[],
  grantWires: readonly Uint8Array[],
  pageSize: number,
  offset: number,
): readonly Uint8Array[] {
  const wires = entries.map(envelopeOf).filter((w): w is Uint8Array => w !== undefined);
  const pages: Uint8Array[] = [];
  let index = 0;
  do {
    const slice = wires.slice(index, index + pageSize);
    index += pageSize;
    const grantsForPage = index <= pageSize ? [...grantWires] : [];
    pages.push(pageFrame(grantsForPage, slice, index < wires.length, offset));
  } while (index < wires.length);
  return pages;
}

export async function openRelayRoom(
  options: RelayRoomOptions,
): Promise<Result<RelayRoom, StoreFailure>> {
  const { name, store, epoch, keepaliveMs = 15_000, pageSize = 2000, maxBacklog = 1000 } = options;
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
  const fan = options.fanout?.connect(name);
  const offFan = fan?.onFrame((frame) => toClients(frame));
  const keepalive = setInterval(() => toClients(kaFrame()), keepaliveMs);

  const connect = (socket: RelaySocket): RelayConnection => {
    const sender = createSender(socket, maxBacklog);
    let me: PeerId | undefined;

    const refuse = (code: string, message: string, fatal = false): void => {
      sender.send(errorFrame(code, message));
      if (fatal) socket.close(code);
    };

    const catchUp = (theirs: ReadonlyMap<PeerId, SeqNum>): void => {
      queue = queue.then(async () => {
        const entries = await store.allSince(theirs);
        if (entries.isErr()) {
          refuse("store", entries.error.message);
          return;
        }
        for (const page of paged(entries.value, [...grants.values()], pageSize, offset))
          sender.send(page);
      });
    };

    const onJoin = (
      versions: readonly number[],
      peer: PeerId,
      theirs: ReadonlyMap<PeerId, SeqNum>,
    ): void => {
      const shared = versions.filter((v) => RELAY_PROTOCOL_VERSIONS.includes(v));
      const selected = shared.length > 0 ? Math.max(...shared) : undefined;
      if (selected === undefined) {
        refuse("version", `this relay speaks ${RELAY_PROTOCOL_VERSIONS.join(", ")}`, true);
        return;
      }
      // one socket per peer, never a silent room switch: the old socket goes first
      clients.get(peer)?.socket.close("superseded by a newer join");
      clients.delete(peer);
      me = peer;
      clients.set(peer, { peer, sender, socket });
      sender.send(helloFrame(selected, keepaliveMs, epoch, new Map(cursors)));
      // who is here now — never how they got here: presence has no history to page through
      for (const entry of presence.all()) sender.send(presenceFrame(entry.wire));
      catchUp(theirs);
      // what the joiner holds, in its own words, for everyone else's `delivered`
      toClients(cursorsFrame(peer, theirs), peer);
    };

    const onEvent = (wire: Uint8Array): void => {
      queue = queue.then(async () => {
        const verified = decodeAndVerify(wire);
        if (verified.isErr()) {
          refuse("bad-event", verified.error.message);
          return;
        }
        // locality never reaches the wire: the envelope has no field for it, so a local
        // event cannot arrive here — the device-side writer and codec enforce that (D20)
        const { event } = verified.value;
        const held = await store.has(event.id);
        if (held.isErr()) {
          refuse("store", held.error.message);
          return;
        }
        if (!held.value) {
          const appended = await store.append(verified.value);
          if (appended.isErr()) {
            refuse("store", appended.error.message);
            return;
          }
          offset += 1;
          advance(event.peerId, event.seqNum);
          const relayed = relayedFrame(wire, offset);
          toClients(relayed, event.peerId);
          fan?.publish(relayed);
        }
        // the durability ack, idempotent: what a write handle's synced() counts
        sender.send(ackFrame(String(event.id), offset));
      });
    };

    /** A cursor moved: admit it, forward it byte-identical, and drop it if it is not news. */
    const onPresence = (bytes: Uint8Array, wire: Uint8Array): void => {
      const verified = decodeAndVerifyPresence(wire);
      if (verified.isErr()) return; // junk from a client is dropped, never relayed
      if (!presence.admit(verified.value)) return; // a stale value or a loop's echo stops here
      toClients(bytes, me);
      fan?.publish(bytes);
    };

    const onGrant = (bytes: Uint8Array, wire: Uint8Array): void => {
      const key = bytesToHex(wire);
      if (grants.has(key)) return;
      grants.set(key, wire);
      // the received frame bytes, untouched: grants forward byte-identical, never re-encoded
      toClients(bytes, me);
      fan?.publish(bytes);
    };

    return {
      receive: (bytes) => {
        const decoded = decodeRelayFrame(bytes);
        if (decoded.isErr()) {
          refuse("malformed", decoded.error.message);
          return;
        }
        const frame = decoded.value;
        if (frame.kind === "join") {
          onJoin(frame.versions, frame.peerId, frame.cursors);
          return;
        }
        if (me === undefined) {
          refuse("join-first", "the first frame on a relay socket is join", true);
          return;
        }
        if (frame.kind !== "session") return; // the relay ignores control frames it did not ask for
        if (frame.frame.kind === "event") onEvent(frame.frame.wire);
        else if (frame.frame.kind === "grant") onGrant(bytes, frame.frame.wire);
        else if (frame.frame.kind === "presence") onPresence(bytes, frame.frame.wire);
        else if (frame.frame.kind === "grant-request" || frame.frame.kind === "cursors")
          toClients(bytes, me); // peer-to-peer facts pass through byte-identical
      },
      drain: () => sender.drain(),
      closed: () => {
        if (me !== undefined && clients.get(me)?.sender === sender) clients.delete(me);
      },
    };
  };

  return Result.ok({
    connect,
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

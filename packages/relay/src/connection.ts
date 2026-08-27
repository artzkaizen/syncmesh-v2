import type { EventStore, Interest, StoredEvent } from "@syncmesh/engine";
import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";
import type { BlobHash, BlobStore } from "@syncmesh/storage";
import type { PresenceStore } from "@syncmesh/transport";

import { matchesInterest } from "@syncmesh/engine";
import { cursorsFrame, presenceFrame } from "@syncmesh/transport";
import {
  decodeAndVerify,
  decodeAndVerifyPresence,
  encodeCbor,
  encodeEventCore,
} from "@syncmesh/wire";

import type { RelayFrame } from "./frames.js";
import type { GrantCache } from "./grant-cache.js";
import type { RelaySocket, Sender } from "./sender.js";

import {
  RELAY_PROTOCOL_VERSIONS,
  ackFrame,
  blobFrame,
  blobMissingFrame,
  decodeRelayFrame,
  errorFrame,
  helloFrame,
  pageFrame,
  relayedFrame,
} from "./frames.js";
import { createSender } from "./sender.js";

/** What the host wires each accepted socket to. */
export interface RelayConnection {
  readonly receive: (bytes: Uint8Array) => void;
  /** The host's socket buffer drained: flush this connection's backlog in order. */
  readonly drain: () => void;
  /** The socket is gone; the host must call this exactly once. */
  readonly closed: () => void;
}

export interface Client {
  readonly peer: PeerId;
  readonly sender: Sender;
  readonly socket: RelaySocket;
  /** Whether this client asked for that event (E13); a client with no interest wants them all. */
  readonly wants: (event: SyncEvent) => boolean;
}

/** The room as one connection sees it: shared state, and the three ways to reach the others. */
export interface RoomState {
  readonly store: EventStore;
  readonly epoch: string;
  readonly keepaliveMs: number;
  readonly pageSize: number;
  readonly maxBacklog: number;
  /** Where this room's bytes live (D18); absent, it serves none and says so. */
  readonly blobs: BlobStore | undefined;
  /** One grant per device, the room's newest mint for each; a joiner gets these first. */
  readonly grants: GrantCache;
  readonly presence: PresenceStore;
  readonly clients: Map<PeerId, Client>;
  readonly cursors: Map<PeerId, SeqNum>;
  /** Every client but one — the author, who already has what it sent. */
  readonly toClients: (frame: Uint8Array, except?: PeerId) => void;
  /** The same, minus every client whose interest excludes this event (E13). */
  readonly toInterested: (frame: Uint8Array, event: SyncEvent, except?: PeerId) => void;
  /** The same frame to the other instances serving this room; best-effort by design (D09-B). */
  readonly publish: (frame: Uint8Array) => void;
  readonly offset: () => number;
  /** One more event in the log: the offset moves and this author's cursor with it. */
  readonly appended: (peer: PeerId, seq: SeqNum) => void;
  /** Room-serialized async work, so offsets and acks stay ordered. */
  readonly enqueue: (work: () => Promise<void>) => void;
}

/** A stored event back to wire form; `undefined` for an entry whose signature was never stored. */
const envelopeOf = (entry: StoredEvent): Uint8Array | undefined =>
  entry.sig === undefined ? undefined : encodeCbor([encodeEventCore(entry.event), entry.sig]);

/**
 * A joiner's history as frames: `pageSize` events each, grants on the first, and always at least
 * one page — its `more: false` is what releases the client's push-outstanding, so a client that
 * is already caught up still gets told so. One frame is not a transfer, it is a cliff (RFC-0010).
 */
export function paged(
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

/**
 * One connection's whole protocol: the versioned handshake, its paged catch-up, and everything
 * it may send afterwards. Held apart from the room's own state so each reads as what it is — a
 * room is a log, its clients and the current presence; a connection is a conversation with one.
 */
export function createConnection(socket: RelaySocket, room: RoomState): RelayConnection {
  const sender = createSender(socket, room.maxBacklog);
  let me: PeerId | undefined;
  /** What this socket asked for (E13); absent wants everything the policy already allows. */
  let interest: Interest | undefined;

  const refuse = (code: string, message: string, fatal = false): void => {
    sender.send(errorFrame(code, message));
    if (fatal) socket.close(code);
  };

  const catchUp = (theirs: ReadonlyMap<PeerId, SeqNum>): void => {
    room.enqueue(async () => {
      const entries = await room.store.allSince(theirs);
      if (entries.isErr()) {
        refuse("store", entries.error.message);
        return;
      }
      // narrowed at the sender: an event this device did not ask for never becomes a page
      const asked = interest;
      const wanted =
        asked === undefined
          ? entries.value
          : entries.value.filter((entry) => matchesInterest(asked, entry.event));
      const grantWires = room.grants.all();
      for (const page of paged(wanted, grantWires, room.pageSize, room.offset())) sender.send(page);
    });
  };

  /** Live fan-out obeys the same interest the catch-up did, so the two never disagree. */
  const wants = (event: SyncEvent): boolean =>
    interest === undefined || matchesInterest(interest, event);

  const onJoin = (
    versions: readonly number[],
    peer: PeerId,
    theirs: ReadonlyMap<PeerId, SeqNum>,
    wanted: Interest | undefined,
  ): void => {
    const shared = versions.filter((v) => RELAY_PROTOCOL_VERSIONS.includes(v));
    const selected = shared.length > 0 ? Math.max(...shared) : undefined;
    if (selected === undefined) {
      refuse("version", `this relay speaks ${RELAY_PROTOCOL_VERSIONS.join(", ")}`, true);
      return;
    }
    // one socket per peer, never a silent room switch: the old socket goes first
    room.clients.get(peer)?.socket.close("superseded by a newer join");
    room.clients.delete(peer);
    me = peer;
    interest = wanted;
    room.clients.set(peer, { peer, sender, socket, wants });
    sender.send(helloFrame(selected, room.keepaliveMs, room.epoch, new Map(room.cursors)));
    // who is here now — never how they got here: presence has no history to page through
    for (const entry of room.presence.all()) sender.send(presenceFrame(entry.wire));
    catchUp(theirs);
    // what the joiner holds, in its own words, for everyone else's `delivered`
    room.toClients(cursorsFrame(peer, theirs), peer);
  };

  const onEvent = (wire: Uint8Array): void => {
    room.enqueue(async () => {
      const verified = decodeAndVerify(wire);
      if (verified.isErr()) {
        refuse("bad-event", verified.error.message);
        return;
      }
      // locality never reaches the wire: the envelope has no field for it, so a local event
      // cannot arrive here — the device-side writer and codec enforce that (D20)
      const { event } = verified.value;
      const held = await room.store.has(event.id);
      if (held.isErr()) {
        refuse("store", held.error.message);
        return;
      }
      if (!held.value) {
        const appended = await room.store.append(verified.value);
        if (appended.isErr()) {
          refuse("store", appended.error.message);
          return;
        }
        room.appended(event.peerId, event.seqNum);
        const relayed = relayedFrame(wire, room.offset());
        room.toInterested(relayed, event, event.peerId);
        room.publish(relayed);
      }
      // the durability ack, idempotent: what a write handle's synced() counts
      sender.send(ackFrame(String(event.id), room.offset()));
    });
  };

  /** A cursor moved: admit it, forward it byte-identical, and drop it if it is not news. */
  const onPresence = (bytes: Uint8Array, wire: Uint8Array): void => {
    const verified = decodeAndVerifyPresence(wire);
    if (verified.isErr()) return; // junk from a client is dropped, never relayed
    if (!room.presence.admit(verified.value)) return; // a stale value or a loop's echo stops here
    room.toClients(bytes, me);
    room.publish(bytes);
  };

  const onGrant = (bytes: Uint8Array, wire: Uint8Array): void => {
    if (!room.grants.admit(wire)) return;
    // the received frame bytes, untouched: grants forward byte-identical, never re-encoded
    room.toClients(bytes, me);
    room.publish(bytes);
  };

  /**
   * Bytes by name (D18). A put is verified before it is stored, so junk cannot squat a hash; a
   * get answers with the bytes or `blob-missing`, which is a value the fetcher can act on —
   * anyone still holding them can put them back under the same name.
   */
  const onBlob = (frame: Extract<RelayFrame, { kind: "blob-put" | "blob-get" }>): void => {
    room.enqueue(async () => {
      // SAFETY: a hash off the wire is opaque here; the store verifies it against the bytes
      const hash = frame.hash as BlobHash;
      if (frame.kind === "blob-put") {
        const stored = await room.blobs?.putAt(hash, frame.bytes);
        if (stored?.isErr() === true) refuse("blob-corrupt", stored.error.message);
        return;
      }
      const found = await room.blobs?.get(hash);
      if (found === undefined || found.isErr()) sender.send(blobMissingFrame(frame.hash));
      else sender.send(blobFrame(frame.hash, found.value));
    });
  };

  const onSession = (bytes: Uint8Array, frame: Extract<RelayFrame, { kind: "session" }>): void => {
    if (frame.frame.kind === "event") onEvent(frame.frame.wire);
    else if (frame.frame.kind === "grant") onGrant(bytes, frame.frame.wire);
    else if (frame.frame.kind === "presence") onPresence(bytes, frame.frame.wire);
    else if (frame.frame.kind === "grant-request" || frame.frame.kind === "cursors")
      room.toClients(bytes, me); // peer-to-peer facts pass through byte-identical
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
        onJoin(frame.versions, frame.peerId, frame.cursors, frame.interest);
        return;
      }
      if (me === undefined) {
        refuse("join-first", "the first frame on a relay socket is join", true);
        return;
      }
      if (frame.kind === "blob-put" || frame.kind === "blob-get") onBlob(frame);
      // anything else control-shaped is one the relay did not ask for, and ignores
      else if (frame.kind === "session") onSession(bytes, frame);
    },
    drain: () => sender.drain(),
    closed: () => {
      if (me !== undefined && room.clients.get(me)?.sender === sender) room.clients.delete(me);
    },
  };
}

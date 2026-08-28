import type { Interest } from "@syncmesh/engine";
import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";

import { matchesInterest, timed } from "@syncmesh/engine";
import { cursorsFrame, presenceFrame } from "@syncmesh/transport";
import { decodeAndVerifyPresence } from "@syncmesh/wire";

import type { RelayFrame } from "./frames.js";
import type { TrafficClass } from "./limits.js";
import type { RelaySocket } from "./sender.js";
import type { Conversation, RoomState } from "./state.js";

import { sendCatchUp } from "./catchup.js";
import { decodeRelayFrame, errorFrame, helloFrame, selectVersion } from "./frames.js";
import { ingestEvent, serveBlob } from "./ingest.js";
import { createBudget } from "./limits.js";
import { BELOW_FLOOR, belowFloor } from "./retention.js";
import { createSender } from "./sender.js";

/** What the host wires each accepted socket to. */
export interface RelayConnection {
  readonly receive: (bytes: Uint8Array) => void;
  /** The host's socket buffer drained: flush this connection's backlog in order. */
  readonly drain: () => void;
  /** The socket is gone; the host must call this exactly once. */
  readonly closed: () => void;
}

/** Which bucket a frame spends from: bulk is priced apart from everything else. */
const trafficOf = (kind: RelayFrame["kind"]): TrafficClass =>
  kind === "blob-put" || kind === "blob-get" ? "blob" : "event";

/**
 * One connection's whole protocol: the versioned handshake, its paged catch-up, and everything
 * it may send afterwards. Held apart from the room's own state so each reads as what it is — a
 * room is a log, its clients and the current presence; a connection is a conversation with one.
 *
 * Every ceiling here closes rather than buffers. A relay that queues for a client it cannot keep
 * up with is a relay any one client can exhaust for everybody, and hanging up costs that client
 * nothing it cannot recover: its reconnect re-joins from its own cursors, and the room's dedup
 * makes the re-push a no-op.
 */
export function createConnection(socket: RelaySocket, room: RoomState): RelayConnection {
  const sender = createSender(socket, room.maxBacklog);
  let me: PeerId | undefined;
  /**
   * A fatal refusal ends the conversation here and not only on the socket. `close()` starts a
   * handshake; frames the runtime had already buffered still arrive after it, and a token bucket
   * refills while they do. One of those appended after a refusal leaves the room's log holding
   * N+1 without N — a hole every later joiner is paged and no author ever re-sends.
   */
  let closed = false;
  /** What this socket asked for; absent wants everything the policy already allows. */
  let interest: Interest | undefined;

  const refuse = (code: string, message: string, fatal = false): void => {
    sender.send(errorFrame(code, message));
    if (fatal) {
      closed = true;
      socket.close(code);
    }
  };

  const conversation: Conversation = {
    room,
    sender,
    budget: createBudget(room.limits, room.now),
    refuse,
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
    const selected = selectVersion(versions, room.versions);
    if (selected === undefined) {
      refuse("version", `this relay speaks ${room.versions.join(", ")}`, true);
      return;
    }
    /**
     * Told, rather than paged a run with its bottom missing. A hole would not corrupt this
     * client — its own coverage stops below a gap — but every event above the gap would sit in
     * its holdback until that overflowed into a re-join, which re-requests the same missing run
     * from the same room, forever.
     *
     * Not permanent the way a version refusal is: the socket closes, the client reconnects on its
     * backoff, and the join after it succeeds the moment the gap has been filled from a peer that
     * still holds it. This room simply is not where that history lives any more.
     *
     * This is the cheap half — before hello, before registration, before any page — and it reads
     * the floor as it stands right now. A sweep already on the room's queue has not moved it yet,
     * so `sendCatchUp` asks the same question again from inside that queue, where the answer is
     * final.
     */
    if (belowFloor(theirs, room.floor())) {
      refuse("retention", BELOW_FLOOR, true);
      return;
    }
    const [greeted, duration] = timed(() => {
      // one socket per peer, never a silent room switch: the old socket goes first
      room.clients.get(peer)?.socket.close("superseded by a newer join");
      room.clients.delete(peer);
      me = peer;
      interest = wanted;
      room.clients.set(peer, { peer, sender, socket, wants });
      sender.send(helloFrame(selected, room.keepaliveMs, room.epoch, room.cursors(), room.floor()));
      // who is here now — never how they got here: presence has no history to page through
      const here = room.presence.all();
      for (const entry of here) sender.send(presenceFrame(entry.wire));
      sendCatchUp(conversation, theirs, wanted);
      // what the joiner holds, in its own words, for everyone else's `delivered`
      room.toClients(cursorsFrame(peer, theirs), peer);
      return here.length;
    });
    room.report({
      type: "relay.join",
      sizes: { cursors: theirs.size, presence: greeted },
      duration,
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

  const onSession = (bytes: Uint8Array, frame: Extract<RelayFrame, { kind: "session" }>): void => {
    if (frame.frame.kind === "event") ingestEvent(conversation, frame.frame.wire);
    else if (frame.frame.kind === "grant") onGrant(bytes, frame.frame.wire);
    else if (frame.frame.kind === "presence") onPresence(bytes, frame.frame.wire);
    else if (frame.frame.kind === "grant-request" || frame.frame.kind === "cursors")
      room.toClients(bytes, me); // peer-to-peer facts pass through byte-identical
  };

  return {
    receive: (bytes) => {
      if (closed) return;
      // the cheapest refusal there is: a frame over the cap is never decoded, only measured
      if (bytes.byteLength > room.limits.maxFrameBytes) {
        refuse("frame-too-large", `frames are capped at ${room.limits.maxFrameBytes} bytes`, true);
        return;
      }
      const decoded = decodeRelayFrame(bytes);
      if (decoded.isErr()) {
        refuse("malformed", decoded.error.message);
        return;
      }
      const frame = decoded.value;
      // an unknown tag spends a token too: it cost a decode, whatever this build made of it
      const traffic = trafficOf(frame.kind);
      if (!conversation.budget.take(traffic)) {
        refuse("rate", `this socket is over its ${traffic} rate`, true);
        return;
      }
      if (frame.kind === "join") {
        onJoin(frame.versions, frame.peerId, frame.cursors, frame.interest);
        return;
      }
      if (me === undefined) {
        refuse("join-first", "the first frame on a relay socket is join", true);
        return;
      }
      if (frame.kind === "blob-put" || frame.kind === "blob-get") serveBlob(conversation, frame);
      // anything else control-shaped is one the relay did not ask for, and ignores
      else if (frame.kind === "session") onSession(bytes, frame);
    },
    drain: () => sender.drain(),
    closed: () => {
      closed = true;
      if (me !== undefined && room.clients.get(me)?.sender === sender) room.clients.delete(me);
    },
  };
}

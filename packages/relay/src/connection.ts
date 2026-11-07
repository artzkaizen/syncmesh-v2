import type { Interest } from "@syncmesh/engine";
import type { PeerId, SyncEvent } from "@syncmesh/kernel";

import { matchesInterest, timed } from "@syncmesh/engine";
import { omitUndefined } from "@syncmesh/result";
import { SEAL_OVERHEAD, cursorsFrame, presenceFrame } from "@syncmesh/transport";
import { decodeAndVerifyPresence } from "@syncmesh/wire";

import type { RelayFrame } from "./frames.js";
import type { TrafficClass } from "./limits.js";
import type { LinkOffer, LinkSession, SecureLink } from "./secure.js";
import type { RelaySocket } from "./sender.js";
import type { Conversation, RoomState } from "./state.js";

import { sendCatchUp } from "./catchup.js";
import {
  challengeFrame,
  decodeRelayFrame,
  errorFrame,
  helloFrame,
  selectVersion,
  speaksHandshake,
} from "./frames.js";
import { ingestEvent, serveBlob } from "./ingest.js";
import { createBudget } from "./limits.js";
import { newChallenge, verifyJoinProof } from "./proof.js";
import { BELOW_FLOOR, belowFloor } from "./retention.js";
import { secureLink } from "./secure.js";
import { createSender } from "./sender.js";

/** What the host wires each accepted socket to. */
export interface RelayConnection {
  /**
   * The challenge this socket was sent, for a host that must hand it back after a sleep (D33).
   * Absent on a room that speaks the link handshake instead (D36).
   */
  readonly challenge: Uint8Array | undefined;
  /**
   * The link hello this socket was sent and the secret behind it (D36), for a host that must
   * finish the handshake after a sleep; `undefined` once the peer's hello has arrived, and on a
   * room that challenges instead.
   */
  readonly offer: () => LinkOffer | undefined;
  /** Whole socket bytes in: `open` then `replay`. */
  readonly receive: (bytes: Uint8Array) => void;
  /**
   * The plaintext frame these socket bytes carry, or `undefined` when they carried none to act
   * on: a handshake frame, or bytes the link refused (and said so). On a challenging room the
   * bytes are the frame. A host that keeps a resume script reads this before {@link replay}.
   */
  readonly open: (bytes: Uint8Array) => Uint8Array | undefined;
  /** One plaintext frame acted on — what a host replays from its resume script after a sleep. */
  readonly replay: (frame: Uint8Array) => void;
  /** The host's socket buffer drained: flush this connection's backlog in order. */
  readonly drain: () => void;
  /** The socket is gone; the host must call this exactly once. */
  readonly closed: () => void;
}

/** How a host opens a connection it is picking back up rather than starting. */
export interface ConnectionOptions {
  /**
   * The challenge this socket already holds — a hibernating host waking a socket it challenged
   * before it slept. Given, no new one is sent, because the client is about to answer the old one.
   */
  readonly challenge?: Uint8Array;
  /** The hello this socket was already sent, and the secret behind it (D36); no new one is sent. */
  readonly offer?: LinkOffer;
  /** The link session this socket already agreed (D36); no hello is sent and none is expected. */
  readonly session?: LinkSession;
  /** The handshake completed on this socket: what a host must keep to open it again after a sleep. */
  readonly onSecured?: (session: LinkSession) => void;
}

/** A socket that seals what the room sends once the link has a key, and passes the hello before. */
const sealing = (socket: RelaySocket, link: SecureLink): RelaySocket => ({
  // before the key exists the only things the room says are its hello and a handshake refusal,
  // both of which have to be readable by an end that cannot open anything yet
  send: (frame) => socket.send(link.seal(frame) ?? frame),
  close: socket.close,
});

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
export function createConnection(
  raw: RelaySocket,
  room: RoomState,
  options: ConnectionOptions = {},
): RelayConnection {
  /**
   * The room speaks first, either way. On a v3 room its first frame is a signed hello and every
   * frame after the peer's is sealed (D36); on an older room it is a challenge the join has to
   * sign (D33). Both are sent before anything is known about the far end, because they are what
   * make the first thing the far end says about itself checkable.
   */
  const link = speaksHandshake(room.versions)
    ? secureLink(room.identity, omitUndefined({ offer: options.offer, session: options.session }))
    : undefined;
  const socket = link === undefined ? raw : sealing(raw, link);
  const sender = createSender(socket, room.maxBacklog, room.limits.maxBacklogBytes);
  if (link?.hello !== undefined) sender.send(link.hello);
  const challenge = link === undefined ? (options.challenge ?? newChallenge()) : undefined;
  if (challenge !== undefined && options.challenge === undefined)
    sender.send(challengeFrame(challenge));
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

  const onJoin = (frame: Extract<RelayFrame, { kind: "join" }>): void => {
    const { versions, peerId: peer, cursors: theirs, interest: wanted } = frame;
    const selected = selectVersion(versions, room.versions);
    if (selected === undefined) {
      refuse("version", `this relay speaks ${room.versions.join(", ")}`, true);
      return;
    }
    /**
     * The join names a key. On a sealed link the hello already proved one, and the join must name
     * that one (D36): a device cannot open a link as itself and sit down as somebody else. At v2 it
     * proves the key by signing the challenge (D33). Both are checked before the seat is taken — a
     * name nobody proved must not be able to close the socket of the device that owns it — and a
     * proof that fails is a refusal on any version: an operator who lists 1 has chosen to take a
     * bare join on trust, not to take a wrong signature for one.
     */
    const opened = link?.session()?.peer;
    if (link !== undefined && opened !== peer) {
      refuse("impostor", "the join names a key other than the one that opened this link", true);
      return;
    }
    const proven =
      frame.proof === undefined || challenge === undefined
        ? undefined
        : verifyJoinProof(peer, challenge, frame.core, frame.proof);
    if (proven === false || (proven === undefined && selected === 2)) {
      refuse(
        "unproven",
        proven === false
          ? "the join was not signed by the key it names"
          : "a v2 join signs the room's challenge with the key it names",
        true,
      );
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

  /**
   * Socket bytes to the frame they carry. On a sealed link the peer's hello completes the
   * handshake and carries nothing; anything the link refuses is a fatal `handshake`, because a
   * frame in the clear after the hellos is a downgrade, and one that does not open is not ours.
   */
  const open = (bytes: Uint8Array): Uint8Array | undefined => {
    if (closed) return undefined;
    // the cheapest refusal there is: a frame over the cap is never decoded, only measured
    if (bytes.byteLength > room.limits.maxFrameBytes + (link === undefined ? 0 : SEAL_OVERHEAD)) {
      refuse("frame-too-large", `frames are capped at ${room.limits.maxFrameBytes} bytes`, true);
      return undefined;
    }
    if (link === undefined) return bytes;
    const before = link.session();
    const opened = link.receive(bytes);
    if (opened.isErr()) {
      refuse("handshake", opened.error.message, true);
      return undefined;
    }
    const session = link.session();
    if (before === undefined && session !== undefined) options.onSecured?.(session);
    return opened.value;
  };

  const replay = (bytes: Uint8Array): void => {
    if (closed) return;
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
    // what its last frames cost the room, not what they cost to receive: a socket that owes
    // fan-out is one whose writes are being multiplied across a crowd (gap audit №7). Asked
    // rather than spent, so an event in a room of one — which amplifies nothing — costs nothing
    if (traffic === "event" && conversation.budget.owes("fanout")) {
      refuse("rate", "this socket is over its fanout rate", true);
      return;
    }
    if (frame.kind === "join") {
      onJoin(frame);
      return;
    }
    if (me === undefined) {
      refuse("join-first", "the first frame on a relay socket is join", true);
      return;
    }
    if (frame.kind === "blob-put" || frame.kind === "blob-get") serveBlob(conversation, frame);
    // anything else control-shaped is one the relay did not ask for, and ignores
    else if (frame.kind === "session") onSession(bytes, frame);
  };

  return {
    challenge,
    offer: () => link?.offer(),
    open,
    replay,
    receive: (bytes) => {
      const frame = open(bytes);
      if (frame !== undefined) replay(frame);
    },
    drain: () => sender.drain(),
    closed: () => {
      closed = true;
      if (me !== undefined && room.clients.get(me)?.sender === sender) room.clients.delete(me);
    },
  };
}

import type { Coverage, Cursors, Interest } from "@syncmesh/engine";
import type { PartitionKey, PeerId, SeqNum } from "@syncmesh/kernel";
import type { Frame } from "@syncmesh/transport";
import type { CborValue } from "@syncmesh/wire";

import { interestText } from "@syncmesh/engine";
import { cursorPairs } from "@syncmesh/transport";
import { encodeCbor, hexToBytes } from "@syncmesh/wire";

/**
 * The relay's control vocabulary (D14): its own additive tag space above the session frames,
 * so grants and events pass through the relay byte-identical under their existing tags and a
 * future version adds tags without renumbering these.
 */
export const KIND = {
  join: 8,
  hello: 9,
  error: 10,
  ka: 11,
  ack: 12,
  page: 13,
  relayed: 14,
  blobPut: 15,
  blobGet: 16,
  blob: 17,
  blobMissing: 18,
  challenge: 19,
  blobStored: 20,
  blobRefused: 21,
  /**
   * A signed refusal of one event, on its way to the author (D32). The session tag for it, 9, is
   * `hello` here, so across a relay it travels under a control tag of its own; additive, so a
   * relay or a client built before it ignores the frame.
   */
  refusal: 22,
  /**
   * A joiner took its seat: sent by the room to every other socket in it, and to the room's other
   * instances (D32, U38). A holder says again what of the joiner's writes it refused once per
   * seating, not once per cursors frame. Additive, so a relay or a client built before it ignores
   * the frame.
   */
  seated: 23,
} as const;

/**
 * The protocol this build speaks; `join` offers, `hello` picks the highest in common.
 *
 * **3** — the socket runs the link handshake: both ends send a signed hello first, everything
 * after travels sealed, and the join names the key the hello proved (D36). **2** — the room
 * challenges first and the join proves the key it names (D33); the link's secrecy is `wss://`'s.
 * **1** — the bare join, believed on its word. Neither 1 nor 2 is offered by this build; a room
 * admits them only when its operator lists them, and a room lists 3 alone or not at all: it speaks
 * a hello first or a challenge first, and a socket cannot be told both.
 */
export const RELAY_PROTOCOL_VERSIONS: readonly number[] = [3];

/** The version from which a relay socket is a sealed link (D36). */
export const HANDSHAKE_VERSION = 3;

/** Whether a room or a client offering these versions opens every socket with the link handshake. */
export const speaksHandshake = (versions: readonly number[]): boolean =>
  versions.includes(HANDSHAKE_VERSION);

/** What a challenge is: this many bytes, fresh per socket, and nothing else. */
export const CHALLENGE_BYTES = 32;

/**
 * D14's whole negotiation: the highest version both sides speak, or `undefined` for no overlap —
 * a refusal the relay can explain, never a guess it decodes into. A room may narrow `spoken` to
 * raise its floor, which is how a `v: 2` client meets a relay that has stopped accepting 2.
 */
export const selectVersion = (
  offered: readonly number[],
  spoken: readonly number[] = RELAY_PROTOCOL_VERSIONS,
): number | undefined => {
  const shared = offered.filter((version) => spoken.includes(version));
  return shared.length > 0 ? Math.max(...shared) : undefined;
};

export type RelayFrame =
  /** A session frame (grant, grant-request, cursors, event) carried unchanged. */
  | { readonly kind: "session"; readonly frame: Frame }
  | {
      readonly kind: "join";
      readonly versions: readonly number[];
      readonly peerId: PeerId;
      readonly cursors: Cursors;
      /** What this device wants; absent asks for everything its policy already allows. */
      readonly interest?: Interest;
      /** The join's body as the proof covers it: versions, peer, cursors, interest, re-encoded canonically. */
      readonly core: Uint8Array;
      /**
       * The named key's signature over the room's challenge and `core` (D33). Absent on a v1
       * join, and on a v3 join, where the hello that opened the link already proved the key (D36).
       */
      readonly proof?: Uint8Array;
    }
  /** The room's first frame on every socket: what a v2 join has to sign (D33). */
  | { readonly kind: "challenge"; readonly nonce: Uint8Array }
  | {
      readonly kind: "hello";
      readonly version: number;
      readonly keepaliveMs: number;
      readonly epoch: string;
      readonly cursors: Cursors;
      /**
       * Per author, the highest sequence this room has trimmed. The pair with `cursors` is
       * what catch-up can serve — a room that keeps everything sends it empty, and a build older
       * than retention sends nothing here, which decodes to the same empty map and says the same
       * thing: nothing has been taken away.
       */
      readonly floor: Cursors;
      /**
       * Whether this room's log outlives the process serving it (D42): only then is its `ack` an
       * answer to `synced()`. An additive element — a relay built before it sends nothing here,
       * which decodes as `false`, so an older room's acks are never taken for durability.
       */
      readonly durable: boolean;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
      /** On a `retention` refusal, the room's floor as the refusal read it (gaps U30). */
      readonly floor?: Cursors;
    }
  | { readonly kind: "ka" }
  | { readonly kind: "ack"; readonly id: string; readonly offset: number }
  | {
      readonly kind: "page";
      readonly grants: readonly Uint8Array[];
      readonly events: readonly Uint8Array[];
      readonly more: boolean;
      readonly offset: number;
      /**
       * On the last page of a filtered catch-up: how far the relay's *unfiltered* run reached,
       * and the interest it filtered by (D23). Absent from an unfiltered catch-up and from any
       * page but the last, because it is only true once every page before it has landed.
       */
      readonly scoped?: Coverage;
    }
  | { readonly kind: "relayed"; readonly wire: Uint8Array; readonly offset: number }
  /**
   * Bytes offered under their own hash; the relay verifies before it stores (D18). `partition`
   * is whose byte budget they are billed to — an additive element, so a relay built before it
   * reads the two in front and stops, and a put without one shares the unnamed budget.
   */
  | {
      readonly kind: "blob-put";
      readonly hash: string;
      readonly bytes: Uint8Array;
      readonly partition?: PartitionKey;
    }
  | { readonly kind: "blob-get"; readonly hash: string }
  | { readonly kind: "blob"; readonly hash: string; readonly bytes: Uint8Array }
  /** Nobody here holds them — a value, and recoverable: whoever has the bytes can put them back. */
  | { readonly kind: "blob-missing"; readonly hash: string }
  /** The relay kept the bytes put under this name: the author may stop being their only holder. */
  | { readonly kind: "blob-stored"; readonly hash: string }
  /**
   * The relay would not keep them, and stored nothing. `code` is the reason, spelled so a later
   * build can add one an older client ignores; `quota` carries the partition's budget and spend,
   * and `no-store` (limit and used both 0) says the room keeps no blobs at all.
   */
  | {
      readonly kind: "blob-refused";
      readonly hash: string;
      readonly code: string;
      readonly limit: number;
      readonly used: number;
      readonly partition?: PartitionKey;
    }
  /**
   * A refusal receipt (D32), the signed wire unchanged: from the refuser to the room, and from the
   * room to the author it names and nobody else. A custody receipt needs no tag of its own — its
   * session tag, 7, is below the relay's — and passes as a `session` frame.
   */
  | { readonly kind: "refusal"; readonly wire: Uint8Array }
  /** `peer` sat down in this room, on this instance or another: a new seating begins (U38). */
  | { readonly kind: "seated"; readonly peer: PeerId }
  /** A tag this build does not know; ignored, never an error (D14's additive vector). */
  | { readonly kind: "unknown" };

/** What a build older than the `hello` floor sent in its place: nothing has been taken away. */
export const NO_CURSORS = new Map<PeerId, SeqNum>();

const pairs = (cursors: Cursors): CborValue =>
  [...cursors].map(([peer, seq]): CborValue => [hexToBytes(peer).unwrap(), seq]);

/** The four elements a join is made of, as CBOR values; the frame and the proof both read them. */
const joinParts = (
  versions: readonly number[],
  peerId: PeerId,
  cursors: Cursors,
  interest: Interest | undefined,
): readonly CborValue[] => [
  [...versions],
  hexToBytes(peerId).unwrap(),
  pairs(cursors),
  interestText(interest),
];

/**
 * The bytes a join proof signs: the join's own body, canonically encoded, with the tag and the
 * proof itself left out. A room recomputes this from what it decoded — canonical CBOR is what
 * makes the re-encode land on the same bytes — so a join altered in flight fails its own proof.
 */
export const joinCore = (
  versions: readonly number[],
  peerId: PeerId,
  cursors: Cursors,
  interest?: Interest,
): Uint8Array => encodeCbor([...joinParts(versions, peerId, cursors, interest)]);

/** A join; with `proof`, a v2 join (see {@link joinCore} for what the proof is over). */
export const joinFrame = (
  versions: readonly number[],
  peerId: PeerId,
  cursors: Cursors,
  interest?: Interest,
  proof?: Uint8Array,
): Uint8Array => {
  const parts = joinParts(versions, peerId, cursors, interest);
  return encodeCbor(proof === undefined ? [KIND.join, ...parts] : [KIND.join, ...parts, proof]);
};

export const challengeFrame = (nonce: Uint8Array): Uint8Array =>
  encodeCbor([KIND.challenge, nonce]);

export const helloFrame = (
  version: number,
  keepaliveMs: number,
  epoch: string,
  cursors: Cursors,
  floor: Cursors = NO_CURSORS,
  durable = false,
): Uint8Array => {
  const parts = [KIND.hello, version, keepaliveMs, epoch, pairs(cursors), pairs(floor)];
  // absent rather than `0` for a log that dies with the process: the same bytes it always was
  return encodeCbor(durable ? [...parts, 1] : parts);
};

/**
 * A typed refusal. A `retention` refusal carries the floor it was below as one additive element
 * (gaps U30), so the device can name it; an older client reads the two before it and stops.
 */
export const errorFrame = (code: string, message: string, floor?: Cursors): Uint8Array =>
  encodeCbor(
    floor === undefined ? [KIND.error, code, message] : [KIND.error, code, message, pairs(floor)],
  );

export const kaFrame = (): Uint8Array => encodeCbor([KIND.ka]);

export const ackFrame = (id: string, offset: number): Uint8Array =>
  encodeCbor([KIND.ack, id, offset]);

/**
 * The `scoped` tail rides only the last page of a *filtered* catch-up (D23). It is one additive
 * element, so a relay that never sends it and a client that never reads it both behave exactly
 * as before — an older build reads the element before it and stops (D14).
 */
export const pageFrame = (
  grants: readonly Uint8Array[],
  events: readonly Uint8Array[],
  more: boolean,
  offset: number,
  scoped?: Coverage,
): Uint8Array =>
  encodeCbor(
    scoped === undefined || scoped.scope === undefined
      ? [KIND.page, [...grants], [...events], more ? 1 : 0, offset]
      : [
          KIND.page,
          [...grants],
          [...events],
          more ? 1 : 0,
          offset,
          [cursorPairs(scoped.synced), scoped.scope],
        ],
  );

export const relayedFrame = (wire: Uint8Array, offset: number): Uint8Array =>
  encodeCbor([KIND.relayed, wire, offset]);

export const blobPutFrame = (
  hash: string,
  bytes: Uint8Array,
  partition?: PartitionKey,
): Uint8Array =>
  encodeCbor(
    partition === undefined ? [KIND.blobPut, hash, bytes] : [KIND.blobPut, hash, bytes, partition],
  );

export const blobGetFrame = (hash: string): Uint8Array => encodeCbor([KIND.blobGet, hash]);

export const blobFrame = (hash: string, bytes: Uint8Array): Uint8Array =>
  encodeCbor([KIND.blob, hash, bytes]);

export const blobMissingFrame = (hash: string): Uint8Array => encodeCbor([KIND.blobMissing, hash]);

export const blobStoredFrame = (hash: string): Uint8Array => encodeCbor([KIND.blobStored, hash]);

/** `[wire]` — a refusal receipt across a relay, under the control tag its session tag collides with. */
export const roomRefusalFrame = (wire: Uint8Array): Uint8Array => encodeCbor([KIND.refusal, wire]);

/** `[peer]` — a joiner took its seat; the room's own frame, never a client's. */
export const seatedFrame = (peer: PeerId): Uint8Array =>
  encodeCbor([KIND.seated, hexToBytes(peer).unwrap()]);

/**
 * The sender slot a seating goes out under (`Sender.sendLatest`): a newer seating of the same peer
 * supersedes one a stalled socket has not been sent yet, so seatings never fill its backlog.
 */
export const seatedSlot = (peer: PeerId): string => `seated:${peer}`;

/** `[hash, code, limit, used, partition?]` — the partition last, absent for the unnamed budget. */
export const blobRefusedFrame = (
  hash: string,
  code: string,
  limit: number,
  used: number,
  partition?: PartitionKey,
): Uint8Array =>
  encodeCbor(
    partition === undefined
      ? [KIND.blobRefused, hash, code, limit, used]
      : [KIND.blobRefused, hash, code, limit, used, partition],
  );

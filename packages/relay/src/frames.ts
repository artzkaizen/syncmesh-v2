import type { Coverage, Cursors, Interest } from "@syncmesh/engine";
import type { PartitionKey, PeerId, SeqNum } from "@syncmesh/kernel";
import type { Frame, MalformedFrame } from "@syncmesh/transport";
import type { CborValue } from "@syncmesh/wire";

import { interestFrom, interestText } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { Result, omitUndefined } from "@syncmesh/result";
import {
  asPeer,
  cursorPairs,
  decodeCursorPairs,
  decodeFrame,
  malformedFrame,
} from "@syncmesh/transport";
import { decodeCbor, encodeCbor, hexToBytes, isSafeNonNegative, isString } from "@syncmesh/wire";

/**
 * The relay's control vocabulary (D14): its own additive tag space above the session frames,
 * so grants and events pass through the relay byte-identical under their existing tags and a
 * future version adds tags without renumbering these.
 */
const KIND = {
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
    }
  | { readonly kind: "error"; readonly code: string; readonly message: string }
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
  /** A tag this build does not know; ignored, never an error (D14's additive vector). */
  | { readonly kind: "unknown" };

/** What a build older than the `hello` floor sent in its place: nothing has been taken away. */
const NO_CURSORS = new Map<PeerId, SeqNum>();

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
): Uint8Array =>
  encodeCbor([KIND.hello, version, keepaliveMs, epoch, pairs(cursors), pairs(floor)]);

export const errorFrame = (code: string, message: string): Uint8Array =>
  encodeCbor([KIND.error, code, message]);

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

const asWires = (value: CborValue | undefined): Result<readonly Uint8Array[], MalformedFrame> => {
  if (!Array.isArray(value)) return malformedFrame("wires are not an array");
  const wires: Uint8Array[] = [];
  for (const wire of value) {
    if (!(wire instanceof Uint8Array)) return malformedFrame("wire is not bytes");
    wires.push(wire);
  }
  return Result.ok(wires);
};

type ControlDecoder = (
  a: CborValue | undefined,
  b: CborValue | undefined,
  c: CborValue | undefined,
  d: CborValue | undefined,
  e: CborValue | undefined,
) => Result<RelayFrame, MalformedFrame>;

const decodeJoin: ControlDecoder = (a, b, c, d, e) =>
  Result.gen(function* () {
    if (!Array.isArray(a) || !a.every((v) => isSafeNonNegative(v)))
      return malformedFrame("join versions are not integers");
    const peerId = yield* asPeer(b);
    const cursors = yield* decodeCursorPairs(c);
    const interest = interestFrom(isString(d) ? d : undefined);
    if (e !== undefined && !(e instanceof Uint8Array))
      return malformedFrame("join proof is not bytes");
    // the body as the sender signed it: `b` is the peer's bytes and `d` its interest text, both
    // already validated above, so this is the sender's own core and not a reconstruction of it
    // SAFETY: `a`..`d` were just read out of a decoded CBOR array, so each is a CborValue
    const core = encodeCbor([a, b as CborValue, c as CborValue, (d ?? "") as CborValue]);
    const join = { kind: "join", versions: a, peerId, cursors, core } as const;
    return Result.ok(omitUndefined({ ...join, interest, proof: e }));
  });

const decodeChallenge: ControlDecoder = (a) =>
  a instanceof Uint8Array && a.length === CHALLENGE_BYTES
    ? Result.ok({ kind: "challenge", nonce: a } as const)
    : malformedFrame(`challenge is not ${CHALLENGE_BYTES} bytes`);

const decodeHello: ControlDecoder = (a, b, c, d, e) =>
  Result.gen(function* () {
    if (!isSafeNonNegative(a) || !isSafeNonNegative(b) || !isString(c))
      return malformedFrame("hello is not [version, keepalive, epoch, cursors]");
    const cursors = yield* decodeCursorPairs(d);
    // absent from a relay built before retention, and empty from one that trims nothing: both
    // mean the same thing, so an older relay is read rather than refused (D14's additive vector)
    const floor = e === undefined ? NO_CURSORS : yield* decodeCursorPairs(e);
    return Result.ok({
      kind: "hello",
      version: a,
      keepaliveMs: b,
      epoch: c,
      cursors,
      floor,
    } as const);
  });

const decodeError: ControlDecoder = (a, b) =>
  isString(a) && isString(b)
    ? Result.ok({ kind: "error", code: a, message: b } as const)
    : malformedFrame("error is not [code, message]");

const decodeAck: ControlDecoder = (a, b) =>
  isString(a) && isSafeNonNegative(b)
    ? Result.ok({ kind: "ack", id: a, offset: b } as const)
    : malformedFrame("ack is not [id, offset]");

const decodePage: ControlDecoder = (a, b, c, d, e) =>
  Result.gen(function* () {
    const grants = yield* asWires(a);
    const events = yield* asWires(b);
    if (!isSafeNonNegative(c) || !isSafeNonNegative(d))
      return malformedFrame("page tail is not [more, offset]");
    const page = { kind: "page", grants, events, more: c === 1, offset: d } as const;
    if (e === undefined) return Result.ok(page);
    if (!Array.isArray(e) || e.length !== 2 || !isString(e[1]))
      return malformedFrame("page scope is not [cursors, interest]");
    const synced = yield* decodeCursorPairs(e[0]);
    // `local` is never anyone else's to speak for: a relay describes the synced half and no more
    const scoped: Coverage = { synced, local: NO_CURSORS, scope: e[1] };
    return Result.ok({ ...page, scoped });
  });

/** An optional partition element: absent is the unnamed budget, anything else must parse. */
const optionalPartition = (
  value: CborValue | undefined,
  kind: string,
): Result<PartitionKey | undefined, MalformedFrame> => {
  if (value === undefined) return Result.ok(undefined);
  const parsed = isString(value) ? parsePartitionKey(value) : undefined;
  return parsed?.isOk() === true
    ? Result.ok(parsed.value)
    : malformedFrame(`${kind} partition is not a partition key`);
};

/** `[hash, bytes]` — the blob frame that carries content back. */
const decodeBlob: ControlDecoder = (a, b) =>
  isString(a) && b instanceof Uint8Array
    ? Result.ok({ kind: "blob", hash: a, bytes: b } as const)
    : malformedFrame("blob is not [hash, bytes]");

/** `[hash, bytes, partition?]` — content offered, and whose budget it is billed to. */
const decodeBlobPut: ControlDecoder = (a, b, c) =>
  Result.gen(function* () {
    if (!isString(a) || !(b instanceof Uint8Array))
      return malformedFrame("blob-put is not [hash, bytes]");
    const partition = yield* optionalPartition(c, "blob-put");
    return Result.ok(omitUndefined({ kind: "blob-put", hash: a, bytes: b, partition } as const));
  });

const decodeBlobRefused: ControlDecoder = (a, b, c, d, e) =>
  Result.gen(function* () {
    if (!isString(a) || !isString(b) || !isSafeNonNegative(c) || !isSafeNonNegative(d))
      return malformedFrame("blob-refused is not [hash, code, limit, used]");
    const partition = yield* optionalPartition(e, "blob-refused");
    return Result.ok(
      omitUndefined({
        kind: "blob-refused",
        hash: a,
        code: b,
        limit: c,
        used: d,
        partition,
      } as const),
    );
  });

/** `[hash]` — the frames that name one without carrying it. */
const decodeBlobHash =
  (kind: "blob-get" | "blob-missing" | "blob-stored"): ControlDecoder =>
  (a) =>
    isString(a) ? Result.ok({ kind, hash: a } as const) : malformedFrame(`${kind} is not [hash]`);

const decodeRelayed: ControlDecoder = (a, b) =>
  a instanceof Uint8Array && isSafeNonNegative(b)
    ? Result.ok({ kind: "relayed", wire: a, offset: b } as const)
    : malformedFrame("relayed is not [wire, offset]");

/** One decoder per control tag; an unlisted tag is `unknown`, never an error (D14). */
const CONTROL = new Map<number, ControlDecoder>([
  [KIND.join, decodeJoin],
  [KIND.hello, decodeHello],
  [KIND.error, decodeError],
  [KIND.ka, () => Result.ok({ kind: "ka" } as const)],
  [KIND.ack, decodeAck],
  [KIND.page, decodePage],
  [KIND.relayed, decodeRelayed],
  [KIND.blobPut, decodeBlobPut],
  [KIND.blobGet, decodeBlobHash("blob-get")],
  [KIND.blob, decodeBlob],
  [KIND.blobMissing, decodeBlobHash("blob-missing")],
  [KIND.challenge, decodeChallenge],
  [KIND.blobStored, decodeBlobHash("blob-stored")],
  [KIND.blobRefused, decodeBlobRefused],
]);

/**
 * Dispatched on the tag, and on the relay's own tags first. The two tag spaces cannot both claim
 * one — D14 put the control tags above the session tags precisely so they never collide — so the
 * order changes no outcome except this: `ka` is a bare tag with nothing after it, and the session
 * decoder refuses a one-element frame as malformed rather than passing it on as `unknown`. Asking
 * it first meant every keepalive decoded as an error; only the client's re-arm running before the
 * decode kept that from being visible.
 */
export function decodeRelayFrame(bytes: Uint8Array): Result<RelayFrame, MalformedFrame> {
  const outer = decodeCbor(bytes);
  const parts: readonly CborValue[] = outer.isOk() && Array.isArray(outer.value) ? outer.value : [];
  const [kind, a, b, c, d, e] = parts;
  const control = isSafeNonNegative(kind) ? CONTROL.get(kind) : undefined;
  if (control !== undefined) return control(a, b, c, d, e);
  // a bare tag is nobody's session frame — those all carry a payload — so an unrecognised one is
  // a tag some later version added and this build ignores (D14's additive vector), not junk
  if (parts.length === 1 && isSafeNonNegative(kind)) return Result.ok({ kind: "unknown" } as const);
  return Result.gen(function* () {
    const session = yield* decodeFrame(bytes);
    return Result.ok(
      session.kind === "unknown"
        ? ({ kind: "unknown" } as const)
        : ({ kind: "session", frame: session } as const),
    );
  });
}

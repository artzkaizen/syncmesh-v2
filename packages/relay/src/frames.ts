import type { Coverage, Cursors, Interest } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Frame, MalformedFrame } from "@syncmesh/transport";
import type { CborValue } from "@syncmesh/wire";

import { interestFrom, interestText } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
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
} as const;

/** The protocol this build speaks; `join` offers, `hello` picks the highest in common. */
export const RELAY_PROTOCOL_VERSIONS: readonly number[] = [1];

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
    }
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
  /** Bytes offered under their own hash; the relay verifies before it stores (D18). */
  | { readonly kind: "blob-put"; readonly hash: string; readonly bytes: Uint8Array }
  | { readonly kind: "blob-get"; readonly hash: string }
  | { readonly kind: "blob"; readonly hash: string; readonly bytes: Uint8Array }
  /** Nobody here holds them — a value, and recoverable: whoever has the bytes can put them back. */
  | { readonly kind: "blob-missing"; readonly hash: string }
  /** A tag this build does not know; ignored, never an error (D14's additive vector). */
  | { readonly kind: "unknown" };

/** What a build older than the `hello` floor sent in its place: nothing has been taken away. */
const NO_CURSORS = new Map<PeerId, SeqNum>();

const pairs = (cursors: Cursors): CborValue =>
  [...cursors].map(([peer, seq]): CborValue => [hexToBytes(peer).unwrap(), seq]);

export const joinFrame = (
  versions: readonly number[],
  peerId: PeerId,
  cursors: Cursors,
  interest?: Interest,
): Uint8Array =>
  encodeCbor([
    KIND.join,
    [...versions],
    hexToBytes(peerId).unwrap(),
    pairs(cursors),
    interestText(interest),
  ]);

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

export const blobPutFrame = (hash: string, bytes: Uint8Array): Uint8Array =>
  encodeCbor([KIND.blobPut, hash, bytes]);

export const blobGetFrame = (hash: string): Uint8Array => encodeCbor([KIND.blobGet, hash]);

export const blobFrame = (hash: string, bytes: Uint8Array): Uint8Array =>
  encodeCbor([KIND.blob, hash, bytes]);

export const blobMissingFrame = (hash: string): Uint8Array => encodeCbor([KIND.blobMissing, hash]);

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

const decodeJoin: ControlDecoder = (a, b, c, d) =>
  Result.gen(function* () {
    if (!Array.isArray(a) || !a.every((v) => isSafeNonNegative(v)))
      return malformedFrame("join versions are not integers");
    const peerId = yield* asPeer(b);
    const cursors = yield* decodeCursorPairs(c);
    const interest = interestFrom(isString(d) ? d : undefined);
    return Result.ok(
      interest === undefined
        ? ({ kind: "join", versions: a, peerId, cursors } as const)
        : ({ kind: "join", versions: a, peerId, cursors, interest } as const),
    );
  });

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

/** `[hash, bytes]` — the two blob frames that carry content. */
const decodeBlobBytes =
  (kind: "blob-put" | "blob"): ControlDecoder =>
  (a, b) =>
    isString(a) && b instanceof Uint8Array
      ? Result.ok({ kind, hash: a, bytes: b } as const)
      : malformedFrame(`${kind} is not [hash, bytes]`);

/** `[hash]` — the two that name one without carrying it. */
const decodeBlobHash =
  (kind: "blob-get" | "blob-missing"): ControlDecoder =>
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
  [KIND.blobPut, decodeBlobBytes("blob-put")],
  [KIND.blobGet, decodeBlobHash("blob-get")],
  [KIND.blob, decodeBlobBytes("blob")],
  [KIND.blobMissing, decodeBlobHash("blob-missing")],
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

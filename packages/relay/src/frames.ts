import type { Cursors } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Frame } from "@syncmesh/transport";
import type { CborValue } from "@syncmesh/wire";

import { parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { MalformedFrame, decodeFrame } from "@syncmesh/transport";
import {
  bytesToHex,
  decodeCbor,
  encodeCbor,
  hexToBytes,
  isSafeNonNegative,
  isString,
} from "@syncmesh/wire";

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

export type RelayFrame =
  /** A session frame (grant, grant-request, cursors, event) carried unchanged. */
  | { readonly kind: "session"; readonly frame: Frame }
  | {
      readonly kind: "join";
      readonly versions: readonly number[];
      readonly peerId: PeerId;
      readonly cursors: Cursors;
    }
  | {
      readonly kind: "hello";
      readonly version: number;
      readonly keepaliveMs: number;
      readonly epoch: string;
      readonly cursors: Cursors;
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

const pairs = (cursors: Cursors): CborValue =>
  [...cursors].map(([peer, seq]): CborValue => [hexToBytes(peer).unwrap(), seq]);

export const joinFrame = (
  versions: readonly number[],
  peerId: PeerId,
  cursors: Cursors,
): Uint8Array =>
  encodeCbor([KIND.join, [...versions], hexToBytes(peerId).unwrap(), pairs(cursors)]);

export const helloFrame = (
  version: number,
  keepaliveMs: number,
  epoch: string,
  cursors: Cursors,
): Uint8Array => encodeCbor([KIND.hello, version, keepaliveMs, epoch, pairs(cursors)]);

export const errorFrame = (code: string, message: string): Uint8Array =>
  encodeCbor([KIND.error, code, message]);

export const kaFrame = (): Uint8Array => encodeCbor([KIND.ka]);

export const ackFrame = (id: string, offset: number): Uint8Array =>
  encodeCbor([KIND.ack, id, offset]);

export const pageFrame = (
  grants: readonly Uint8Array[],
  events: readonly Uint8Array[],
  more: boolean,
  offset: number,
): Uint8Array => encodeCbor([KIND.page, [...grants], [...events], more ? 1 : 0, offset]);

export const relayedFrame = (wire: Uint8Array, offset: number): Uint8Array =>
  encodeCbor([KIND.relayed, wire, offset]);

export const blobPutFrame = (hash: string, bytes: Uint8Array): Uint8Array =>
  encodeCbor([KIND.blobPut, hash, bytes]);

export const blobGetFrame = (hash: string): Uint8Array => encodeCbor([KIND.blobGet, hash]);

export const blobFrame = (hash: string, bytes: Uint8Array): Uint8Array =>
  encodeCbor([KIND.blob, hash, bytes]);

export const blobMissingFrame = (hash: string): Uint8Array => encodeCbor([KIND.blobMissing, hash]);

const malformed = (message: string) => Result.err(new MalformedFrame({ message }));

const asPeer = (value: CborValue | undefined): Result<PeerId, MalformedFrame> =>
  value instanceof Uint8Array
    ? parsePeerId(bytesToHex(value)).mapError((e) => new MalformedFrame({ message: e.message }))
    : malformed("peer id is not bytes");

const asCursors = (value: CborValue | undefined): Result<Cursors, MalformedFrame> =>
  Result.gen(function* () {
    if (!Array.isArray(value)) return malformed("cursors are not an array");
    const cursors = new Map<PeerId, SeqNum>();
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2) return malformed("cursor is not a pair");
      const peer = yield* asPeer(pair[0]);
      if (!isSafeNonNegative(pair[1])) return malformed("cursor seq is not an integer");
      const seq = yield* parseSeqNum(pair[1]).mapError(
        (e) => new MalformedFrame({ message: e.message }),
      );
      cursors.set(peer, seq);
    }
    return Result.ok(cursors);
  });

const asWires = (value: CborValue | undefined): Result<readonly Uint8Array[], MalformedFrame> => {
  if (!Array.isArray(value)) return malformed("wires are not an array");
  const wires: Uint8Array[] = [];
  for (const wire of value) {
    if (!(wire instanceof Uint8Array)) return malformed("wire is not bytes");
    wires.push(wire);
  }
  return Result.ok(wires);
};

type ControlDecoder = (
  a: CborValue | undefined,
  b: CborValue | undefined,
  c: CborValue | undefined,
  d: CborValue | undefined,
) => Result<RelayFrame, MalformedFrame>;

const decodeJoin: ControlDecoder = (a, b, c) =>
  Result.gen(function* () {
    if (!Array.isArray(a) || !a.every((v) => isSafeNonNegative(v)))
      return malformed("join versions are not integers");
    const peerId = yield* asPeer(b);
    const cursors = yield* asCursors(c);
    return Result.ok({ kind: "join", versions: a, peerId, cursors } as const);
  });

const decodeHello: ControlDecoder = (a, b, c, d) =>
  Result.gen(function* () {
    if (!isSafeNonNegative(a) || !isSafeNonNegative(b) || !isString(c))
      return malformed("hello is not [version, keepalive, epoch, cursors]");
    const cursors = yield* asCursors(d);
    return Result.ok({ kind: "hello", version: a, keepaliveMs: b, epoch: c, cursors } as const);
  });

const decodeError: ControlDecoder = (a, b) =>
  isString(a) && isString(b)
    ? Result.ok({ kind: "error", code: a, message: b } as const)
    : malformed("error is not [code, message]");

const decodeAck: ControlDecoder = (a, b) =>
  isString(a) && isSafeNonNegative(b)
    ? Result.ok({ kind: "ack", id: a, offset: b } as const)
    : malformed("ack is not [id, offset]");

const decodePage: ControlDecoder = (a, b, c, d) =>
  Result.gen(function* () {
    const grants = yield* asWires(a);
    const events = yield* asWires(b);
    if (!isSafeNonNegative(c) || !isSafeNonNegative(d))
      return malformed("page tail is not [more, offset]");
    return Result.ok({ kind: "page", grants, events, more: c === 1, offset: d } as const);
  });

/** `[hash, bytes]` — the two blob frames that carry content. */
const decodeBlobBytes =
  (kind: "blob-put" | "blob"): ControlDecoder =>
  (a, b) =>
    isString(a) && b instanceof Uint8Array
      ? Result.ok({ kind, hash: a, bytes: b } as const)
      : malformed(`${kind} is not [hash, bytes]`);

/** `[hash]` — the two that name one without carrying it. */
const decodeBlobHash =
  (kind: "blob-get" | "blob-missing"): ControlDecoder =>
  (a) =>
    isString(a) ? Result.ok({ kind, hash: a } as const) : malformed(`${kind} is not [hash]`);

const decodeRelayed: ControlDecoder = (a, b) =>
  a instanceof Uint8Array && isSafeNonNegative(b)
    ? Result.ok({ kind: "relayed", wire: a, offset: b } as const)
    : malformed("relayed is not [wire, offset]");

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

const decodeControl = (parts: readonly CborValue[]): Result<RelayFrame, MalformedFrame> => {
  const [kind, a, b, c, d] = parts;
  const decoder = isSafeNonNegative(kind) ? CONTROL.get(kind) : undefined;
  return decoder === undefined ? Result.ok({ kind: "unknown" } as const) : decoder(a, b, c, d);
};

/** Session tags decode to `session`; the relay's own tags to their frames; anything else `unknown`. */
export function decodeRelayFrame(bytes: Uint8Array): Result<RelayFrame, MalformedFrame> {
  return Result.gen(function* () {
    const session = yield* decodeFrame(bytes);
    if (session.kind !== "unknown") return Result.ok({ kind: "session", frame: session } as const);
    const outer = yield* decodeCbor(bytes).mapError(
      (e) => new MalformedFrame({ message: e.message }),
    );
    if (!Array.isArray(outer) || outer.length < 1) return malformed("expected [kind, …]");
    return decodeControl(outer);
  });
}

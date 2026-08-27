import type { Cursors } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { CborValue } from "@syncmesh/wire";

import { parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import {
  bytesToHex,
  decodeCbor,
  encodeCbor,
  hexToBytes,
  isSafeNonNegative,
  isString,
} from "@syncmesh/wire";

export class MalformedFrame extends TaggedError("MalformedFrame")<{ message: string }> {}

/** Wire tags; the tag is also the traffic class (grants and cursors ahead of events). */
const KIND = { grant: 0, grantRequest: 1, cursors: 2, event: 3, presence: 4, digest: 5 } as const;

export type Frame =
  | { readonly kind: "grant"; readonly wire: Uint8Array }
  | { readonly kind: "grant-request"; readonly peerId: PeerId; readonly invite?: string }
  | { readonly kind: "cursors"; readonly from: PeerId; readonly cursors: Cursors }
  | { readonly kind: "event"; readonly wire: Uint8Array }
  /** The ephemeral tier (D16): signed, never stored, dropped rather than queued. */
  | { readonly kind: "presence"; readonly wire: Uint8Array }
  /**
   * What the sender holds, as one fingerprint per table, together with the slice it counted
   * (E16). A receiver that holds a different slice compares nothing rather than false-alarming.
   */
  | {
      readonly kind: "digest";
      readonly scope: string;
      /** What the sender had folded when it counted; a receiver holding otherwise concludes nothing. */
      readonly at: Cursors;
      readonly digests: ReadonlyMap<string, bigint>;
    }
  /** A tag this build does not know; ignored, never an error. */
  | { readonly kind: "unknown" };

const peerBytes = (peer: PeerId): Uint8Array => hexToBytes(peer).unwrap();

export const grantFrame = (wire: Uint8Array): Uint8Array => encodeCbor([KIND.grant, wire]);

export const grantRequestFrame = (peerId: PeerId, invite?: string): Uint8Array =>
  encodeCbor(
    invite === undefined
      ? [KIND.grantRequest, peerBytes(peerId)]
      : [KIND.grantRequest, peerBytes(peerId), invite],
  );

export const cursorsFrame = (from: PeerId, cursors: Cursors): Uint8Array =>
  encodeCbor([
    KIND.cursors,
    peerBytes(from),
    [...cursors].map(([peer, seq]): CborValue => [peerBytes(peer), seq]),
  ]);

export const eventFrame = (wire: Uint8Array): Uint8Array => encodeCbor([KIND.event, wire]);

export const presenceFrame = (wire: Uint8Array): Uint8Array => encodeCbor([KIND.presence, wire]);

/**
 * What the sender holds, and the two facts that make it comparable: the slice it counted
 * (`interestKey`) and the events it had folded when it counted them. A receiver differing on
 * either concludes nothing — which is what keeps a peer that is merely behind from looking
 * divergent (E13, E16).
 */
export const digestFrame = (
  scope: string,
  at: Cursors,
  digests: ReadonlyMap<string, bigint>,
): Uint8Array =>
  encodeCbor([
    KIND.digest,
    scope,
    [...at].map(([peer, seq]): CborValue => [peerBytes(peer), seq]),
    [...digests].map(([table, digest]): CborValue => [table, digest.toString(16)]),
  ]);

const malformed = (message: string) => Result.err(new MalformedFrame({ message }));

const asPeer = (value: CborValue | undefined): Result<PeerId, MalformedFrame> =>
  value instanceof Uint8Array
    ? parsePeerId(bytesToHex(value)).mapError((e) => new MalformedFrame({ message: e.message }))
    : malformed("peer id is not bytes");

export function decodeFrame(frame: Uint8Array): Result<Frame, MalformedFrame> {
  return Result.gen(function* () {
    const outer = yield* decodeCbor(frame).mapError(
      (e) => new MalformedFrame({ message: e.message }),
    );
    if (!Array.isArray(outer) || outer.length < 2) return malformed("expected [kind, …]");
    const [kind, payload, extra] = outer;
    if (kind === KIND.grant || kind === KIND.event || kind === KIND.presence) {
      if (!(payload instanceof Uint8Array)) return malformed("payload is not bytes");
      if (kind === KIND.grant) return Result.ok({ kind: "grant", wire: payload } as const);
      if (kind === KIND.event) return Result.ok({ kind: "event", wire: payload } as const);
      return Result.ok({ kind: "presence", wire: payload } as const);
    }
    if (kind === KIND.grantRequest) return decodeRequest(payload, extra);
    if (kind === KIND.cursors) return decodeCursors(payload, extra);
    if (kind === KIND.digest) return decodeDigest(payload, extra, outer[3]);
    return Result.ok({ kind: "unknown" } as const);
  });
}

function decodeRequest(
  payload: CborValue | undefined,
  extra: CborValue | undefined,
): Result<Frame, MalformedFrame> {
  return Result.gen(function* () {
    const peerId = yield* asPeer(payload);
    if (extra === undefined) return Result.ok({ kind: "grant-request", peerId } as const);
    if (!isString(extra)) return malformed("invite is not text");
    return Result.ok({ kind: "grant-request", peerId, invite: extra } as const);
  });
}

function decodeDigest(
  payload: CborValue | undefined,
  at: CborValue | undefined,
  extra: CborValue | undefined,
): Result<Frame, MalformedFrame> {
  if (!isString(payload)) return malformed("digest scope is not text");
  if (!Array.isArray(extra)) return malformed("digests are not an array");
  const cursors = decodeCursorPairs(at);
  if (cursors.isErr()) return Result.err(cursors.error);
  const digests = new Map<string, bigint>();
  for (const pair of extra) {
    if (!Array.isArray(pair) || pair.length !== 2) return malformed("digest is not a pair");
    const [table, hex] = pair;
    if (!isString(table) || !isString(hex)) return malformed("digest is not [table, hex]");
    // a fingerprint that does not parse is one this build cannot compare; refusing the whole
    // frame is right, because a partial comparison would look like agreement it never checked
    try {
      digests.set(table, BigInt(`0x${hex}`));
    } catch {
      return malformed("digest is not hexadecimal");
    }
  }
  return Result.ok({ kind: "digest", scope: payload, at: cursors.value, digests } as const);
}

/** `[[peer, seq], …]` — the shape both the cursors frame and a digest's `at` position carry. */
function decodeCursorPairs(value: CborValue | undefined): Result<Cursors, MalformedFrame> {
  return Result.gen(function* () {
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
}

function decodeCursors(
  payload: CborValue | undefined,
  extra: CborValue | undefined,
): Result<Frame, MalformedFrame> {
  return Result.gen(function* () {
    const from = yield* asPeer(payload);
    const cursors = yield* decodeCursorPairs(extra);
    return Result.ok({ kind: "cursors", from, cursors } as const);
  });
}

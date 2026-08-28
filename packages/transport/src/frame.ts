import type { Ahead, Cursors } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { CborValue } from "@syncmesh/wire";

import { Result } from "@syncmesh/result";
import { decodeCbor, encodeCbor, hexToBytes, isString } from "@syncmesh/wire";

import type { SnapshotFrame } from "./snap-frame.js";

import {
  KIND,
  MalformedFrame,
  aheadPairs,
  asPeer,
  cursorPairs,
  decodeAheadPairs,
  decodeCursorPairs,
  malformedFrame,
} from "./frame-parts.js";
import { decodeSnapshotFrame } from "./snap-frame.js";

export { MalformedFrame } from "./frame-parts.js";

export type Frame =
  | { readonly kind: "grant"; readonly wire: Uint8Array }
  | { readonly kind: "grant-request"; readonly peerId: PeerId; readonly invite?: string }
  | {
      readonly kind: "cursors";
      readonly from: PeerId;
      readonly cursors: Cursors;
      /** What they hold above those cursors; absent from an older build, which says nothing. */
      readonly ahead?: Ahead;
    }
  | { readonly kind: "event"; readonly wire: Uint8Array }
  /** The ephemeral tier (D16): signed, never stored, dropped rather than queued. */
  | { readonly kind: "presence"; readonly wire: Uint8Array }
  /**
   * What the sender holds, as one fingerprint per table, together with the slice it counted.
   * A receiver that holds a different slice compares nothing rather than false-alarming.
   */
  | {
      readonly kind: "digest";
      readonly scope: string;
      /** What the sender had folded when it counted; a receiver holding otherwise concludes nothing. */
      readonly at: Cursors;
      readonly digests: ReadonlyMap<string, bigint>;
      /** What the sender held above `at` when it counted; without it nothing may be compared. */
      readonly ahead?: Ahead;
    }
  /** The join exchange (RFC-0019), one tag with a sub-kind of its own. */
  | SnapshotFrame
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

export const cursorsFrame = (from: PeerId, cursors: Cursors, ahead?: Ahead): Uint8Array =>
  encodeCbor(
    ahead === undefined
      ? [KIND.cursors, peerBytes(from), cursorPairs(cursors)]
      : [KIND.cursors, peerBytes(from), cursorPairs(cursors), aheadPairs(ahead)],
  );

export const eventFrame = (wire: Uint8Array): Uint8Array => encodeCbor([KIND.event, wire]);

export const presenceFrame = (wire: Uint8Array): Uint8Array => encodeCbor([KIND.presence, wire]);

/**
 * What the sender holds, and the two facts that make it comparable: the slice it counted
 * (`interestKey`) and the events it had folded when it counted them. A receiver differing on
 * either concludes nothing — which is what keeps a peer that is merely behind from looking
 * divergent.
 */
export const digestFrame = (
  scope: string,
  at: Cursors,
  digests: ReadonlyMap<string, bigint>,
  ahead?: Ahead,
): Uint8Array => {
  const base: CborValue[] = [
    KIND.digest,
    scope,
    cursorPairs(at),
    [...digests].map(([table, digest]): CborValue => [table, digest.toString(16)]),
  ];
  return encodeCbor(ahead === undefined ? base : [...base, aheadPairs(ahead)]);
};

export function decodeFrame(frame: Uint8Array): Result<Frame, MalformedFrame> {
  return Result.gen(function* () {
    const outer = yield* decodeCbor(frame).mapError(
      (e) => new MalformedFrame({ message: e.message }),
    );
    if (!Array.isArray(outer) || outer.length < 2) return malformedFrame("expected [kind, …]");
    const [kind, payload, extra] = outer;
    if (kind === KIND.grant || kind === KIND.event || kind === KIND.presence) {
      if (!(payload instanceof Uint8Array)) return malformedFrame("payload is not bytes");
      if (kind === KIND.grant) return Result.ok({ kind: "grant", wire: payload } as const);
      if (kind === KIND.event) return Result.ok({ kind: "event", wire: payload } as const);
      return Result.ok({ kind: "presence", wire: payload } as const);
    }
    if (kind === KIND.grantRequest) return decodeRequest(payload, extra);
    if (kind === KIND.cursors) return decodeCursors(payload, extra, outer[3]);
    if (kind === KIND.digest) return decodeDigest(payload, extra, outer[3], outer[4]);
    if (kind === KIND.snapshot) return decodeSnapshotFrame(outer);
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
    if (!isString(extra)) return malformedFrame("invite is not text");
    return Result.ok({ kind: "grant-request", peerId, invite: extra } as const);
  });
}

function decodeDigest(
  payload: CborValue | undefined,
  at: CborValue | undefined,
  extra: CborValue | undefined,
  above: CborValue | undefined,
): Result<Frame, MalformedFrame> {
  if (!isString(payload)) return malformedFrame("digest scope is not text");
  if (!Array.isArray(extra)) return malformedFrame("digests are not an array");
  const cursors = decodeCursorPairs(at);
  if (cursors.isErr()) return Result.err(cursors.error);
  const digests = new Map<string, bigint>();
  for (const pair of extra) {
    if (!Array.isArray(pair) || pair.length !== 2) return malformedFrame("digest is not a pair");
    const [table, hex] = pair;
    if (!isString(table) || !isString(hex)) return malformedFrame("digest is not [table, hex]");
    // a fingerprint that does not parse is one this build cannot compare; refusing the whole
    // frame is right, because a partial comparison would look like agreement it never checked
    const digest = Result.try({ try: () => BigInt(`0x${hex}`), catch: () => undefined });
    if (digest.isErr()) return malformedFrame("digest is not hexadecimal");
    digests.set(table, digest.value);
  }
  const base = { kind: "digest", scope: payload, at: cursors.value, digests } as const;
  if (above === undefined) return Result.ok(base);
  const ahead = decodeAheadPairs(above);
  return ahead.isErr() ? Result.err(ahead.error) : Result.ok({ ...base, ahead: ahead.value });
}

function decodeCursors(
  payload: CborValue | undefined,
  extra: CborValue | undefined,
  above: CborValue | undefined,
): Result<Frame, MalformedFrame> {
  return Result.gen(function* () {
    const from = yield* asPeer(payload);
    const cursors = yield* decodeCursorPairs(extra);
    const base = { kind: "cursors", from, cursors } as const;
    if (above === undefined) return Result.ok(base);
    const ahead = yield* decodeAheadPairs(above);
    return Result.ok({ ...base, ahead });
  });
}

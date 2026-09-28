import type { Ahead, Cursors } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { CborValue } from "@syncmesh/wire";

import { parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { bytesToHex, hexToBytes, isSafeNonNegative } from "@syncmesh/wire";

/**
 * The pieces every frame is built from: the tag space, the one refusal, and the two shapes a
 * peer and a position take. Kept apart from the frames themselves so that the session frames and
 * the join exchange can share them without importing each other.
 */

export class MalformedFrame extends TaggedError("MalformedFrame")<{ message: string }> {}

export const malformedFrame = (message: string) => Result.err(new MalformedFrame({ message }));

/** Wire tags; the tag is also the traffic class (grants and cursors ahead of events). */
export const KIND = {
  grant: 0,
  grantRequest: 1,
  cursors: 2,
  event: 3,
  presence: 4,
  digest: 5,
  snapshot: 6,
  /** A signed acknowledgement of durable custody (book ch. 10); additive, so an older peer ignores it. */
  receipt: 7,
  /** What this peer can reach, and how far away it is (book ch. 17); additive like the rest. */
  routes: 8,
} as const;

/**
 * A wire tag, used as a class: lower goes first out of the outbox, and answers `pickRoutes`
 * when it asks what kind of traffic this is. One tag space, so the two can never disagree.
 */
export type FrameClass = (typeof KIND)[keyof typeof KIND];

/**
 * The class of an encoded frame, without decoding it.
 *
 * Every frame is `[kind, …]` in CBOR, and every kind is a small integer — so the array header is
 * one byte and the tag is the next, literally. Reading those two is what lets a peer session
 * score a frame it is only forwarding: decoding the whole thing to learn that a snapshot page is
 * a snapshot page would be paying for the payload twice.
 *
 * `undefined` for anything that is not one of ours, which the caller treats as the ordinary
 * class rather than as a refusal — a frame nobody sends is divergence, not routing.
 */
export const classOf = (frame: Uint8Array): FrameClass | undefined => {
  const header = frame[0];
  const tag = frame[1];
  // 0x80 is CBOR's array major type; a tag above 23 would not be one byte, and none of ours is
  if (header === undefined || (header & 0xe0) !== 0x80 || tag === undefined || tag > 23)
    return undefined;
  // SAFETY: `KINDS` holds exactly the values of `KIND`, so a tag it contains is a FrameClass
  return KINDS.has(tag) ? (tag as FrameClass) : undefined;
};

const KINDS = new Set<number>(Object.values(KIND));

export const peerBytes = (peer: PeerId): Uint8Array => hexToBytes(peer).unwrap();

export const asPeer = (value: CborValue | undefined): Result<PeerId, MalformedFrame> =>
  value instanceof Uint8Array
    ? parsePeerId(bytesToHex(value)).mapError((e) => new MalformedFrame({ message: e.message }))
    : malformedFrame("peer id is not bytes");

/** `[[peer, seq], …]` — the shape cursors take wherever a position travels. */
export const cursorPairs = (cursors: Cursors): CborValue =>
  [...cursors].map(([peer, seq]): CborValue => [peerBytes(peer), seq]);

/**
 * `[[peer, [seq, …]], …]` — the other half of D13's pair, wherever a position travels. Additive:
 * an older build reads the element before it and stops, which is how it goes on meaning "I did
 * not say" rather than "I hold nothing above my cursor".
 */
export const aheadPairs = (ahead: Ahead): CborValue =>
  [...ahead].map(([peer, seqs]): CborValue => [peerBytes(peer), [...seqs]]);

export function decodeAheadPairs(value: CborValue | undefined): Result<Ahead, MalformedFrame> {
  return Result.gen(function* () {
    if (!Array.isArray(value)) return malformedFrame("ahead is not an array");
    const ahead = new Map<PeerId, readonly SeqNum[]>();
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2) return malformedFrame("ahead is not a pair");
      const peer = yield* asPeer(pair[0]);
      const seqs = pair[1];
      if (!Array.isArray(seqs)) return malformedFrame("ahead sequences are not an array");
      const held: SeqNum[] = [];
      for (const seq of seqs) {
        if (!isSafeNonNegative(seq)) return malformedFrame("ahead seq is not an integer");
        held.push(
          yield* parseSeqNum(seq).mapError((e) => new MalformedFrame({ message: e.message })),
        );
      }
      ahead.set(peer, held);
    }
    return Result.ok(ahead);
  });
}

export function decodeCursorPairs(value: CborValue | undefined): Result<Cursors, MalformedFrame> {
  return Result.gen(function* () {
    if (!Array.isArray(value)) return malformedFrame("cursors are not an array");
    const cursors = new Map<PeerId, SeqNum>();
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2) return malformedFrame("cursor is not a pair");
      const peer = yield* asPeer(pair[0]);
      if (!isSafeNonNegative(pair[1])) return malformedFrame("cursor seq is not an integer");
      const seq = yield* parseSeqNum(pair[1]).mapError(
        (e) => new MalformedFrame({ message: e.message }),
      );
      cursors.set(peer, seq);
    }
    return Result.ok(cursors);
  });
}

import type { Cursors } from "@syncmesh/engine";
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
} as const;

export const peerBytes = (peer: PeerId): Uint8Array => hexToBytes(peer).unwrap();

export const asPeer = (value: CborValue | undefined): Result<PeerId, MalformedFrame> =>
  value instanceof Uint8Array
    ? parsePeerId(bytesToHex(value)).mapError((e) => new MalformedFrame({ message: e.message }))
    : malformedFrame("peer id is not bytes");

/** `[[peer, seq], …]` — the shape cursors take wherever a position travels. */
export const cursorPairs = (cursors: Cursors): CborValue =>
  [...cursors].map(([peer, seq]): CborValue => [peerBytes(peer), seq]);

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

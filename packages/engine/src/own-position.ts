import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { EventStore, StoreFailure } from "./store.js";

/**
 * **A key that outlives its log numbers writes a room already holds** (RFC 0024 G7).
 *
 * An author numbers its writes from its own log, and a room — any peer — takes a second event
 * with an `(author, seq)` it already holds for a duplicate and drops it. Nothing about the new
 * event is invalid, so nothing says so. `deviceIdentity` keeps the key in the database for exactly
 * this reason, but a key can still outlive the log it signed: one kept in a keychain, an authority
 * redeployed over an empty volume under its configured keypair, a store restored from an older
 * copy, one key handed to two stores.
 *
 * The floor is the highest sequence of this device's own author known to exist outside this log:
 * what a room said it holds, or an own event that came back from a peer. Numbering never goes at
 * or below it. Not persisted: after a restart the log holds whatever the floor was protecting,
 * because own events that come back are stored like anyone else's.
 */
export interface OwnFloor {
  readonly get: () => number;
  readonly raise: (seq: number) => void;
}

export const createOwnFloor = (): OwnFloor => {
  let floor = 0;
  return {
    get: () => floor,
    raise: (seq) => {
      if (seq > floor) floor = seq;
    },
  };
};

/** The last sequence to number after: the log's, or the floor when the floor is higher. */
export const pastFloor = (last: SeqNum | undefined, floor: number): SeqNum | undefined =>
  // SAFETY: the floor only ever holds a sequence a room or a verified event reported, so a
  // positive one is a SeqNum; 0 means none and leaves the log's answer standing
  floor > (last ?? 0) ? (floor as SeqNum) : last;

/** What a room's position for this device's own author meant for this log. */
export type OwnPosition =
  /** The room holds nothing of ours this log lacks: the normal case. */
  | { readonly kind: "known" }
  /** The room holds writes of ours this log never had, and this log wrote none: numbering resumes after the room. */
  | { readonly kind: "resumed"; readonly room: SeqNum }
  /**
   * As `resumed`, but this log had already numbered writes of its own in the range the room holds.
   * Unless they are the very events the room holds (a log restored from an older copy), they reuse
   * pairs the room has for other events and will never be delivered. Said, not repaired:
   * re-signing them under new numbers would re-author them (see `stranded.ts`).
   */
  | { readonly kind: "collided"; readonly room: SeqNum; readonly held: SeqNum };

/** What a transport should say about a position, if anything: only a collision loses writes. */
export const ownPositionWarning = (position: OwnPosition): string | undefined =>
  position.kind === "collided"
    ? `the room holds writes by this device up to ${position.room} that this log never had ` +
      `(it holds up to ${position.held}): the log was lost, restored from an older copy, or its ` +
      `key signs another log too. Any write this log numbered up to ${position.held} that the ` +
      `room does not already hold byte for byte reuses a number the room has for another event ` +
      `and will not be delivered; new writes resume after ${position.room}`
    : undefined;

/** Takes on a room's position for this device's own author; see {@link OwnFloor}. */
export const adoptOwnPosition = async (
  store: EventStore,
  peerId: PeerId,
  floor: OwnFloor,
  room: SeqNum,
): Promise<Result<OwnPosition, StoreFailure>> => {
  const last = await store.lastSeq(peerId, "synced");
  if (last.isErr()) return Result.err(last.error);
  const held = last.value ?? 0;
  if (room <= held || room <= floor.get()) {
    floor.raise(room);
    return Result.ok({ kind: "known" });
  }
  floor.raise(room);
  return Result.ok(
    last.value === undefined
      ? { kind: "resumed", room }
      : { kind: "collided", room, held: last.value },
  );
};

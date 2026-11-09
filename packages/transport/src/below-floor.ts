import type { Cursors } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";

/**
 * Per author, the sender's floor this device is below: its contiguous cursor `c` is under the
 * floor `f` the sender claims (at `c = f` it already holds everything removed).
 *
 * A floor entry above the sender's own cursor for that author is ignored — a peer cannot have
 * removed events it does not hold — and so is this device's own author: a peer that removed this
 * device's own events below its cursor is holding what this device lost, which is not a question
 * state answers.
 *
 * @example
 * belowPeerFloor(self, new Map([[a, 1]]), new Map([[a, 9]]), new Map([[a, 5]])) // Map { a => 5 }
 */
export function belowPeerFloor(
  self: PeerId,
  ours: Cursors,
  theirs: Cursors,
  floor: Cursors,
): ReadonlyMap<PeerId, SeqNum> {
  const below = new Map<PeerId, SeqNum>();
  for (const [author, seq] of floor) {
    if (author === self || seq > (theirs.get(author) ?? 0)) continue;
    if ((ours.get(author) ?? 0) < seq) below.set(author, seq);
  }
  return below;
}

/**
 * Per author, in the floor's order, the floor a relay's `retention` refusal names that a join
 * sending `ours` is still below (gaps U30, U37). Unlike {@link belowPeerFloor} every author counts,
 * this device's own included: the room trimmed it and refused the join for it. Empty means the next
 * join would be served, and the link dials.
 *
 * @example
 * belowRelayFloor(new Map([[a, 1], [b, 7]]), new Map([[a, 5], [b, 6]])) // Map { a => 5 }
 */
export function belowRelayFloor(ours: Cursors, floor: Cursors): ReadonlyMap<PeerId, SeqNum> {
  return new Map([...floor].filter(([author, seq]) => (ours.get(author) ?? 0) < seq));
}

/** Why a device below a peer's floor is still there, as a stable cause. */
export type BelowFloorReason =
  /** The mesh has no `trust`: nothing can vouch for the state, so nothing was asked until accepted. */
  | "untrusted"
  /** `trust` is set and the state arrived without a certificate from it: rows merged, nothing adopted. */
  | "unvouched"
  /** An install completed and some authors are still below: withheld tables, a scoped sender, doc columns. */
  | "incomplete"
  /** Three sessions asked and no install completed (the link dropped, or the state was refused). */
  | "unanswered"
  /**
   * The floor came through a relay, from a peer this device has no link of its own to ask: a
   * relay carries cursors and events, never state (gaps U52).
   */
  | "relayed";

/** A device below a peer's compaction floor, and what is known about why (D46). */
export interface BelowPeerFloor {
  readonly peer: PeerId;
  /** Per author this device is below, the floor the peer claimed. */
  readonly floor: Cursors;
  readonly reason: BelowFloorReason;
  readonly message: string;
}

/**
 * A device a relay refused with `retention`: its join's cursors were below the floor the room
 * had trimmed to, so the room has no history to page it (gaps U30). A relay folds nothing and
 * serves no state, so the way out is state from a peer that folds — a peer link's own rejoin, or
 * `$recovery.rebuild` — and the link does not dial that room again until this device's next join
 * would be at or above the floor, or something wakes it (`Transport.wake`).
 */
export interface BelowRelayFloor {
  /** The relay transport's name; one issue is kept per name, so give each relay its own. */
  readonly relay: string;
  /** Per author this device's join was below, the floor the room said it had trimmed to. */
  readonly floor: Cursors;
  readonly reason: "retention";
  readonly message: string;
}

/**
 * Below a floor, whichever side said so: a peer's cursors frame (D46) or a relay's `retention`
 * refusal (gaps U30). `reason` tells them apart.
 */
export type BelowFloor = BelowPeerFloor | BelowRelayFloor;

import type { PeerId } from "@syncmesh/kernel";

import { Temporal } from "@syncmesh/temporal";

/**
 * How long a peer stays claimed after it was last heard through this relay.
 *
 * Long against the cursor traffic that re-arms it — a device that is moving at all reports its
 * position far more often than this — and short against somebody leaving a building. Erring long
 * would be the worse mistake: a claim outranks a medium that says nothing, so an entry that
 * outlives the peer pulls frames away from the radio that is actually holding them.
 */
const HEARD_TTL = Temporal.Duration.from({ seconds: 60 });

/**
 * Peers whose traffic has come through one relay link, and when each was last heard.
 *
 * What `Transport.delivers` answers from. Timed out rather than kept, because a claim that
 * outlives the peer is worse than no claim at all: routing ranks a claim above a medium that
 * says nothing, so a stale entry here would pull frames away from a radio that *is* holding the
 * device. {@link HEARD_TTL} is generous against the cursor traffic that feeds it — a live peer
 * re-arms its entry every time it moves — and short against a person walking out of a building.
 */
export interface Heard {
  /** Marks the peer as heard now. */
  readonly note: (peer: PeerId) => void;
  /** The claimed peers, with the ones that have gone quiet dropped on the way past. */
  readonly current: () => ReadonlySet<PeerId>;
}

/** An empty set of heard peers. */
export function createHeard(): Heard {
  const heard = new Map<PeerId, Temporal.Instant>();
  return {
    note: (peer) => void heard.set(peer, Temporal.Now.instant()),
    current: () => {
      const cutoff = Temporal.Now.instant().subtract(HEARD_TTL);
      for (const [peer, at] of heard)
        if (Temporal.Instant.compare(at, cutoff) < 0) heard.delete(peer);
      return new Set(heard.keys());
    },
  };
}

import type { Cursors } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { TransportContext } from "@syncmesh/transport";

/**
 * Peers' floors the room passes on (gaps U52), judged against what this device holds.
 *
 * The room seats a joiner before it pages it, so a forwarded cursors frame can arrive between two
 * pages of the very run its floor names. A floor heard while the session is paging is kept, the
 * latest per peer, and judged once that catch-up has folded; one heard after is judged behind the
 * fold chain.
 */
export interface RelayedFloors {
  /** A peer's cursors frame came through the room. */
  readonly heard: (peer: PeerId, theirs: Cursors, floor?: Cursors) => void;
  /** A last page has landed: every floor kept while paging is judged behind its folds. */
  readonly caughtUp: () => void;
}

/**
 * One session's relayed floors: paging until its first catch-up lands, and again while `repaging`.
 * `after` queues work behind the session's fold chain.
 */
export function createRelayedFloors(
  context: Pick<TransportContext, "engine" | "rejoins">,
  after: (work: () => void) => void,
  repaging: () => boolean,
): RelayedFloors {
  let caughtUp = false;
  const kept = new Map<PeerId, { theirs: Cursors; floor: Cursors | undefined }>();
  const judge = (peer: PeerId, theirs: Cursors, floor: Cursors | undefined): void =>
    after(() => context.rejoins?.relayedFloor(context.engine, peer, theirs, floor));
  return {
    heard: (peer, theirs, floor) => {
      if (!caughtUp || repaging()) kept.set(peer, { theirs, floor });
      else judge(peer, theirs, floor);
    },
    caughtUp: () => {
      caughtUp = true;
      for (const [peer, { theirs, floor }] of kept) judge(peer, theirs, floor);
      kept.clear();
    },
  };
}

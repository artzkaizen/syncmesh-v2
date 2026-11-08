import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";

import { EMPTY_COVERAGE, type Ahead, type Coverage, type Cursors } from "./sync.js";

/**
 * One author's position on this device: everything at or below `contiguous` has landed, and
 * `ahead` is what landed past a gap (D13). A MAX cursor collapses the pair into its larger half,
 * which is the same as claiming the gap was delivered — and a claim nothing can take back, since
 * anti-entropy asks for events *above* the cursor and would never ask for the hole again.
 */
interface Chain {
  contiguous: SeqNum | undefined;
  /** Sequence numbers above `contiguous`, keyed by their numeric value so the run can be walked. */
  readonly ahead: Map<number, SeqNum>;
}

const authorChain = (chains: Map<PeerId, Chain>, peer: PeerId): Chain => {
  const held = chains.get(peer);
  if (held !== undefined) return held;
  const fresh: Chain = { contiguous: undefined, ahead: new Map() };
  chains.set(peer, fresh);
  return fresh;
};

/** Walks the run above `contiguous`, moving each sequence number it finds out of `ahead`. */
const close = (chain: Chain): void => {
  for (;;) {
    const next = Number(chain.contiguous ?? 0) + 1;
    const seq = chain.ahead.get(next);
    if (seq === undefined) return;
    chain.contiguous = seq;
    chain.ahead.delete(next);
  }
};

export interface CoverageTracker {
  /** Records the event in the author's chain; the cursor stops below a gap rather than jumping it. */
  readonly note: (event: Pick<SyncEvent, "peerId" | "seqNum" | "local">) => void;
  /**
   * Takes on what a snapshot stood for (RFC-0019), raising each author's cursor and never
   * lowering one — a snapshot older than what this device already holds must not un-hold it.
   *
   * A `scope` on what is adopted is taken on with it (D23): the numbers and the interest that
   * makes them true are one claim, and holding the first without the second is what turns a
   * scoped cursor into a lie with better manners. Adopting an unscoped coverage clears it, which
   * is the honest direction — everything below N unqualified is the stronger claim.
   */
  readonly adopt: (coverage: Coverage) => void;
  /**
   * {@link CoverageTracker.adopt} for a snapshot install, which also raises the floor: what it
   * adopts has no log behind it, bar what was folded past a gap (D46). A pass-over or a purge
   * adopts with `adopt` and raises no floor — a relay or the authority fills that gap, not state.
   */
  readonly adoptUnheld: (coverage: Coverage) => void;
  /** The cursors, their scope, and the floor when there is one; what the state store persists. */
  readonly current: () => Coverage;
  /** Per author, what this device holds above its contiguous cursor: the far side of every gap. */
  readonly ahead: () => Ahead;
}

export function trackCoverage(initial: Coverage = EMPTY_COVERAGE): CoverageTracker {
  const scopes = { synced: new Map<PeerId, Chain>(), local: new Map<PeerId, Chain>() };
  // set only by `adopt`: folding an event is evidence of that event and of nothing about a slice
  let scope = initial.scope;
  // raised only by `adoptUnheld`, never lowered: the log does not say which holes a snapshot left
  let floor: Cursors = initial.floor ?? new Map();
  const seed = (chains: Map<PeerId, Chain>, cursors: Coverage["synced"]) => {
    for (const [peer, seq] of cursors) chains.set(peer, { contiguous: seq, ahead: new Map() });
  };
  seed(scopes.synced, initial.synced);
  seed(scopes.local, initial.local);

  const raise = (chains: Map<PeerId, Chain>, peer: PeerId, seq: SeqNum): void => {
    const chain = authorChain(chains, peer);
    if (Number(chain.contiguous ?? 0) >= Number(seq)) return;
    chain.contiguous = seq;
    for (const at of [...chain.ahead.keys()]) if (at <= Number(seq)) chain.ahead.delete(at);
    close(chain);
  };

  const contiguousCursors = (chains: Map<PeerId, Chain>): Coverage["synced"] => {
    const cursors = new Map<PeerId, SeqNum>();
    for (const [peer, chain] of chains)
      if (chain.contiguous !== undefined) cursors.set(peer, chain.contiguous);
    return cursors;
  };

  const ahead = (): Ahead => {
    const out = new Map<PeerId, readonly SeqNum[]>();
    for (const [peer, chain] of scopes.synced) {
      if (chain.ahead.size === 0) continue;
      out.set(
        peer,
        [...chain.ahead.entries()].sort(([a], [b]) => a - b).map(([, seq]) => seq),
      );
    }
    return out;
  };

  const adopt = (adopted: Coverage): void => {
    for (const [peer, seq] of adopted.synced) raise(scopes.synced, peer, seq);
    for (const [peer, seq] of adopted.local) raise(scopes.local, peer, seq);
    scope = adopted.scope;
  };

  return {
    note: (event) => {
      const chain = authorChain(event.local === true ? scopes.local : scopes.synced, event.peerId);
      const at = Number(event.seqNum);
      if (at <= Number(chain.contiguous ?? 0)) return;
      chain.ahead.set(at, event.seqNum);
      close(chain);
    },
    adopt,
    adoptUnheld: (adopted) => {
      const from = contiguousCursors(scopes.synced);
      const held = ahead();
      adopt(adopted);
      floor = higherFloor(floor, unheldBelow(from, contiguousCursors(scopes.synced), held));
    },
    current: () => ({
      synced: contiguousCursors(scopes.synced),
      local: contiguousCursors(scopes.local),
      ...(scope !== undefined && { scope }),
      ...(floor.size > 0 && { floor }),
    }),
    ahead,
  };
}

/**
 * Per author, the highest sequence in `(from, to]` this device holds no event for — coverage it
 * claims with no log behind it, which a snapshot install leaves (D46). `held` lists, per author,
 * the sequences in that range the log does hold; an author whose whole range is held is absent.
 *
 * @example
 * unheldBelow(new Map([[a, 1]]), new Map([[a, 5]]), new Map([[a, [4, 5]]])) // Map { a => 3 }
 */
export function unheldBelow(from: Cursors, to: Cursors, held: Ahead): Cursors {
  const unheld = new Map<PeerId, SeqNum>();
  for (const [author, top] of to) {
    const bottom = from.get(author) ?? 0;
    const have = new Set<number>(held.get(author));
    let gap = 0;
    while (top - gap > bottom && have.has(top - gap)) gap += 1;
    if (top - gap <= bottom) continue;
    // SAFETY: above `bottom`, which is at least zero, so a positive sequence number
    unheld.set(author, (top - gap) as SeqNum);
  }
  return unheld;
}

/** Per author, the higher of the two floors: a floor only ever rises. */
export const higherFloor = (a: Cursors, b: Cursors): Cursors => {
  const out = new Map(a);
  for (const [author, seq] of b) if (seq > (out.get(author) ?? 0)) out.set(author, seq);
  return out;
};

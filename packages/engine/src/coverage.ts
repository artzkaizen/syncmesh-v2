import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";

import type { TornRun } from "./store.js";

import { EMPTY_COVERAGE, heldRuns, type Ahead, type Coverage, type Cursors } from "./sync.js";

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

/** Records one sequence number in a chain, closing the run it completes. */
const noteIn = (chain: Chain, seqNum: SeqNum): void => {
  const at = Number(seqNum);
  if (at <= Number(chain.contiguous ?? 0)) return;
  chain.ahead.set(at, seqNum);
  close(chain);
};

/** Takes the run `from..to` back out of a chain: the cursor drops below it, the rest is ahead. */
const reopenIn = (chain: Chain, from: SeqNum, to: SeqNum): void => {
  const top = chain.contiguous ?? 0;
  for (let seq: number = from; seq <= to; seq += 1) chain.ahead.delete(seq);
  if (from > top) return;
  for (let seq = to + 1; seq <= top; seq += 1) {
    // SAFETY: above `to`, which is a positive sequence number, so each one is one too
    chain.ahead.set(seq, seq as SeqNum);
  }
  // SAFETY: at least 1 when the run does not start the author's run, which `> 1` checks
  chain.contiguous = from > 1 ? ((from - 1) as SeqNum) : undefined;
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
  /**
   * Takes back a claim: the run `from..to` of this author is not held after all (D39, a torn log).
   * The cursor drops below it, and what was held above it is kept as held past a gap, so a peer
   * that reads `ahead` sends the hole alone. The one place a cursor is lowered.
   */
  readonly reopen: (run: TornRun) => void;
  /**
   * Takes events this device just deleted from its log out of the held run (D45, D32), and lowers
   * no cursor: each author's held run drops below the lowest one evicted, and what it still holds
   * above that is kept as held past a gap. A custody receipt signs the held run, so a purged
   * holder stops signing for what it no longer has.
   */
  readonly evict: (events: readonly Pick<SyncEvent, "peerId" | "seqNum" | "local">[]) => void;
  /**
   * The cursors, their scope, the floor when there is one, and the held run while scoped or
   * while it stands below the cursors; what the state store persists.
   */
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
  // the synced run folded here, beside the cursors (D32): a scoped adopt raises the cursors past
  // what was withheld and never this, and an unscoped one raises both, so unscoped they agree
  const held = new Map<PeerId, Chain>();
  seed(held, heldRuns(initial));

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
    if (adopted.scope === undefined)
      for (const [peer, seq] of adopted.synced) raise(held, peer, seq);
    scope = adopted.scope;
  };

  return {
    note: (event) => {
      const local = event.local === true;
      noteIn(authorChain(local ? scopes.local : scopes.synced, event.peerId), event.seqNum);
      if (!local) noteIn(authorChain(held, event.peerId), event.seqNum);
    },
    adopt,
    reopen: ({ peer, local, from, to }) => {
      reopenIn(authorChain(local ? scopes.local : scopes.synced, peer), from, to);
      if (!local) reopenIn(authorChain(held, peer), from, to);
    },
    evict: (events) => {
      const seqs = events
        .filter((event) => event.local !== true)
        .sort((a, b) => a.seqNum - b.seqNum);
      // lowest first: the first drops the run below it, and each one after only leaves `ahead`
      for (const { peerId, seqNum } of seqs) reopenIn(authorChain(held, peerId), seqNum, seqNum);
    },
    adoptUnheld: (adopted) => {
      const from = contiguousCursors(scopes.synced);
      const held = ahead();
      adopt(adopted);
      floor = higherFloor(floor, unheldBelow(from, contiguousCursors(scopes.synced), held));
    },
    current: () => {
      const synced = contiguousCursors(scopes.synced);
      const run = contiguousCursors(held);
      return {
        synced,
        local: contiguousCursors(scopes.local),
        ...(scope !== undefined && { scope }),
        ...(floor.size > 0 && { floor }),
        ...((scope !== undefined || !sameCursors(run, synced)) && { held: run }),
      };
    },
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

/** Whether two cursor maps name the same authors at the same sequences. */
const sameCursors = (a: Cursors, b: Cursors): boolean =>
  a.size === b.size && [...a].every(([author, seq]) => b.get(author) === seq);

/** Per author, the higher of the two floors: a floor only ever rises. */
export const higherFloor = (a: Cursors, b: Cursors): Cursors => {
  const out = new Map(a);
  for (const [author, seq] of b) if (seq > (out.get(author) ?? 0)) out.set(author, seq);
  return out;
};

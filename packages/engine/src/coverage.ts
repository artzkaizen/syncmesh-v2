import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";

import { EMPTY_COVERAGE, type Ahead, type Coverage } from "./sync.js";

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

const chainOf = (chains: Map<PeerId, Chain>, peer: PeerId): Chain => {
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
  readonly note: (event: SyncEvent) => void;
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
  readonly current: () => Coverage;
  /** Per author, what this device holds above its contiguous cursor: the far side of every gap. */
  readonly ahead: () => Ahead;
}

export function trackCoverage(initial: Coverage = EMPTY_COVERAGE): CoverageTracker {
  const scopes = { synced: new Map<PeerId, Chain>(), local: new Map<PeerId, Chain>() };
  // set only by `adopt`: folding an event is evidence of that event and of nothing about a slice
  let scope = initial.scope;
  const seed = (chains: Map<PeerId, Chain>, cursors: Coverage["synced"]) => {
    for (const [peer, seq] of cursors) chains.set(peer, { contiguous: seq, ahead: new Map() });
  };
  seed(scopes.synced, initial.synced);
  seed(scopes.local, initial.local);

  const raise = (chains: Map<PeerId, Chain>, peer: PeerId, seq: SeqNum): void => {
    const chain = chainOf(chains, peer);
    if (Number(chain.contiguous ?? 0) >= Number(seq)) return;
    chain.contiguous = seq;
    for (const at of [...chain.ahead.keys()]) if (at <= Number(seq)) chain.ahead.delete(at);
    close(chain);
  };

  const cursorsOf = (chains: Map<PeerId, Chain>): Coverage["synced"] => {
    const cursors = new Map<PeerId, SeqNum>();
    for (const [peer, chain] of chains)
      if (chain.contiguous !== undefined) cursors.set(peer, chain.contiguous);
    return cursors;
  };

  return {
    note: (event) => {
      const chain = chainOf(event.local === true ? scopes.local : scopes.synced, event.peerId);
      const at = Number(event.seqNum);
      if (at <= Number(chain.contiguous ?? 0)) return;
      chain.ahead.set(at, event.seqNum);
      close(chain);
    },
    adopt: (adopted) => {
      for (const [peer, seq] of adopted.synced) raise(scopes.synced, peer, seq);
      for (const [peer, seq] of adopted.local) raise(scopes.local, peer, seq);
      scope = adopted.scope;
    },
    current: () => {
      const coverage = { synced: cursorsOf(scopes.synced), local: cursorsOf(scopes.local) };
      return scope === undefined ? coverage : { ...coverage, scope };
    },
    ahead: () => {
      const ahead = new Map<PeerId, readonly SeqNum[]>();
      for (const [peer, chain] of scopes.synced) {
        if (chain.ahead.size === 0) continue;
        ahead.set(
          peer,
          [...chain.ahead.entries()].sort(([a], [b]) => a - b).map(([, seq]) => seq),
        );
      }
      return ahead;
    },
  };
}

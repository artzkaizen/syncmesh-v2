import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";

import { EMPTY_COVERAGE, type Coverage } from "./sync.js";

export interface CoverageTracker {
  /** Raises the author's cursor in the event's scope; never lowers it. */
  readonly note: (event: SyncEvent) => void;
  /**
   * Takes on what a snapshot stood for (RFC-0019), raising each author's cursor and never
   * lowering one — a snapshot older than what this device already holds must not un-hold it.
   */
  readonly adopt: (coverage: Coverage) => void;
  readonly current: () => Coverage;
}

export function trackCoverage(initial: Coverage = EMPTY_COVERAGE): CoverageTracker {
  const synced = new Map<PeerId, SeqNum>(initial.synced);
  const local = new Map<PeerId, SeqNum>(initial.local);
  return {
    note: (event) => {
      const cursors = event.local === true ? local : synced;
      if ((cursors.get(event.peerId) ?? 0) < event.seqNum) cursors.set(event.peerId, event.seqNum);
    },
    adopt: (adopted) => {
      for (const [peer, seq] of adopted.synced)
        if ((synced.get(peer) ?? 0) < seq) synced.set(peer, seq);
      for (const [peer, seq] of adopted.local)
        if ((local.get(peer) ?? 0) < seq) local.set(peer, seq);
    },
    current: () => ({ synced: new Map(synced), local: new Map(local) }),
  };
}

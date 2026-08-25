import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";

import { EMPTY_COVERAGE, type Coverage } from "./state-store.js";

export interface CoverageTracker {
  /** Raises the author's cursor in the event's scope; never lowers it. */
  readonly note: (event: SyncEvent) => void;
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
    current: () => ({ synced: new Map(synced), local: new Map(local) }),
  };
}

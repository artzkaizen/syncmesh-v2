import type { Change, PeerId, Procedure, SeqNum, SyncEvent } from "@syncmesh/kernel";

import { eventId } from "@syncmesh/kernel";
import { deriveLineage } from "@syncmesh/wire";

import type { MutateOptions } from "./engine.js";

export const nextSeq = (last: SeqNum | undefined): SeqNum => {
  // SAFETY: last is a SeqNum (positive safe integer) or absent; +1 from 0 or from it stays one
  return ((last ?? 0) + 1) as SeqNum;
};

export function buildEvent(
  peerId: PeerId,
  procedure: Procedure,
  hlc: SyncEvent["hlc"],
  seqNum: SeqNum,
  changes: SyncEvent["changes"],
  { partition, local, action, undoOf }: MutateOptions,
): SyncEvent {
  const base = {
    v: 1 as const,
    id: eventId(peerId, seqNum, local === true),
    peerId,
    seqNum,
    hlc,
    procedure,
    changes: changes.map((change, index) => withLineage(change, peerId, seqNum, index)),
    ...(action !== undefined && { action }),
    ...(undoOf !== undefined && { undoOf }),
  };
  if (partition !== undefined && local === true) return { ...base, partition, local };
  if (partition !== undefined) return { ...base, partition };
  if (local === true) return { ...base, local };
  return base;
}

/**
 * A genesis names the lineage derived from where it sits — always, whatever the write said, since
 * a receiver recomputes the derivation and refuses a genesis that names anything else (RFC-0023
 * §5.3, §10). Every other change goes out as recorded.
 */
const withLineage = (change: Change, peerId: PeerId, seqNum: SeqNum, index: number): Change =>
  change.kind === "doc" && change.genesis === true
    ? { ...change, lineage: deriveLineage(peerId, seqNum, index) }
    : change;

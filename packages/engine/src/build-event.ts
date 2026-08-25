import type { PeerId, Procedure, SeqNum, SyncEvent } from "@syncmesh/kernel";

import { eventId } from "@syncmesh/kernel";

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
  { partition, local }: MutateOptions,
): SyncEvent {
  const base = {
    v: 1 as const,
    id: eventId(peerId, seqNum, local === true),
    peerId,
    seqNum,
    hlc,
    procedure,
    changes,
  };
  if (partition !== undefined && local === true) return { ...base, partition, local };
  if (partition !== undefined) return { ...base, partition };
  if (local === true) return { ...base, local };
  return base;
}

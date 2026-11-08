import type {
  Change,
  DocChange,
  LineageId,
  PeerId,
  Procedure,
  SeqNum,
  SyncEvent,
} from "@syncmesh/kernel";

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
  winner: Winner,
): SyncEvent {
  const base = {
    v: 1 as const,
    id: eventId(peerId, seqNum, local === true),
    peerId,
    seqNum,
    hlc,
    procedure,
    changes: changes.map((change, index) => withLineage(change, peerId, seqNum, index, winner)),
    ...(action !== undefined && { action }),
    ...(undoOf !== undefined && { undoOf }),
  };
  if (partition !== undefined && local === true) return { ...base, partition, local };
  if (partition !== undefined) return { ...base, partition };
  if (local === true) return { ...base, local };
  return base;
}

/** The lineage a document is on here, now: what a genesis written here replaces. */
export type Winner = (doc: DocChange) => LineageId | undefined;

/**
 * A genesis names the lineage derived from where it sits — always, whatever the write said, since
 * a receiver recomputes the derivation and refuses a genesis that names anything else (RFC-0023
 * §5.3, §10) — and, as its parent, the lineage that wins on this device as it is written, which is
 * what a replace replaces (§16.1). Every other change goes out as recorded.
 */
function withLineage(
  change: Change,
  peerId: PeerId,
  seqNum: SeqNum,
  index: number,
  winner: Winner,
): Change {
  if (change.kind !== "doc" || change.genesis !== true) return change;
  const { parent: _written, ...rest } = change;
  const parent = winner(change);
  const lineage = deriveLineage(peerId, seqNum, index);
  return parent === undefined ? { ...rest, lineage } : { ...rest, lineage, parent };
}

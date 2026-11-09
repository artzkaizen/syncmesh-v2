import type {
  Change,
  DocChange,
  LineageId,
  PeerId,
  Procedure,
  SchemaVersion,
  SeqNum,
  SettledLineage,
  SyncEvent,
} from "@syncmesh/kernel";

import { docLineage, eventId, getRecord, settleWalk, type Hlc, type State } from "@syncmesh/kernel";
import { type Temporal, addToInstant } from "@syncmesh/temporal";
import { deriveLineage } from "@syncmesh/wire";

import type { MutateOptions } from "./engine.js";

export const nextSeq = (last: SeqNum | undefined): SeqNum => {
  // SAFETY: last is a SeqNum (positive safe integer) or absent; +1 from 0 or from it stays one
  return ((last ?? 0) + 1) as SeqNum;
};

/** The event `author` writes, stamped with its `schemaVersion` when it declares one (D31). */
export function buildEvent(
  author: { readonly peerId: PeerId; readonly schemaVersion?: SchemaVersion | undefined },
  procedure: Procedure,
  hlc: SyncEvent["hlc"],
  seqNum: SeqNum,
  changes: SyncEvent["changes"],
  { partition, local, action, undoOf }: MutateOptions,
  replaces: Replaces,
): SyncEvent {
  const { peerId, schemaVersion } = author;
  const base = {
    v: 1 as const,
    id: eventId(peerId, seqNum, local === true),
    peerId,
    seqNum,
    hlc,
    procedure,
    changes: changes.map((change, index) => withLineage(change, peerId, seqNum, index, replaces)),
    ...(action !== undefined && { action }),
    ...(undoOf !== undefined && { undoOf }),
    ...(schemaVersion !== undefined && { schemaVersion }),
  };
  if (partition !== undefined && local === true) return { ...base, partition, local };
  if (partition !== undefined) return { ...base, partition };
  if (local === true) return { ...base, local };
  return base;
}

/**
 * What a genesis written here, now, replaces: the lineage the document is on (its parent, §16.1),
 * and where its walk may be settled (gaps U21), each `undefined` for none.
 */
export type Replaces = (doc: DocChange) => {
  readonly parent: LineageId | undefined;
  readonly settles: SettledLineage | undefined;
};

/**
 * What a genesis written at `hlc` replaces, read from `state`: the lineage winning here, and the
 * anchor the walk settles at — the deepest lineage on it replaced at least `settleAfter` before
 * (gaps U21).
 */
export const replacesAt =
  (state: () => State, settleAfter: Temporal.Duration, hlc: Hlc): Replaces =>
  (doc) => {
    const record = getRecord(state(), doc.table, doc.key);
    return {
      parent: docLineage(record, doc.column),
      settles: settleWalk(
        record?.cells.get(doc.column)?.value,
        addToInstant(hlc[0], settleAfter.negated()),
      ),
    };
  };

/**
 * A genesis names the lineage derived from where it sits — always, whatever the write said, since
 * a receiver recomputes the derivation and refuses a genesis that names anything else (RFC-0023
 * §5.3, §10) — and, as its parent, the lineage that wins on this device as it is written, which is
 * what a replace replaces (§16.1), and the anchor this device settles the walk at, when one has
 * been replaced long enough ago (gaps U21). It is written under this build's rule, never an
 * earlier one a write named (`rule`, gaps U39). Every other change goes out as recorded.
 */
function withLineage(
  change: Change,
  peerId: PeerId,
  seqNum: SeqNum,
  index: number,
  replaces: Replaces,
): Change {
  if (change.kind !== "doc" || change.genesis !== true) return change;
  const { parent: _written, settles: _settled, rule: _earlier, ...rest } = change;
  const { parent, settles } = replaces(change);
  return {
    ...rest,
    lineage: deriveLineage(peerId, seqNum, index),
    ...(parent !== undefined && { parent }),
    ...(settles !== undefined && { settles }),
  };
}

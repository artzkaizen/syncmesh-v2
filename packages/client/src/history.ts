import type { StoredEvent } from "@syncmesh/engine";
import type {
  Change,
  EventId,
  MergeSpec,
  PartitionKey,
  PeerId,
  RowKey,
  SyncEvent,
} from "@syncmesh/kernel";
import type { Row, Table } from "@syncmesh/schema";
import type { Temporal } from "@syncmesh/temporal";

import { foldable } from "@syncmesh/engine";
import { applyChange, compareStamp, emptyState, readRow, stampOf } from "@syncmesh/kernel";
import { fromWirePatch, fromWireRow } from "@syncmesh/schema";

/** One write in a row's timeline: who set what, and the row as of that write. */
export interface Revision<T extends Table> {
  /** The write's HLC instant — the author's clock, not the reader's. */
  readonly at: Temporal.Instant;
  /** The account the writing device belonged to, when a grant is known. */
  readonly by: string | undefined;
  readonly peerId: PeerId;
  readonly eventId: EventId;
  readonly procedure: string;
  readonly kind: Change["kind"];
  /** What this write set; empty for a delete. */
  readonly changed: Partial<Row<T>>;
  /** The row as of this revision — the fold of every write up to it; `null` once deleted. */
  readonly row: Row<T> | null;
}

export interface HistoryOptions {
  readonly merge: MergeSpec;
  /** Only events of this instance count; `undefined` reads the whole table (global, user, local). */
  readonly partition: PartitionKey | undefined;
  readonly accountOf: (peer: PeerId) => string | undefined;
}

interface Touch {
  readonly event: SyncEvent;
  readonly changes: readonly Change[];
}

/**
 * The row's writes oldest-first by stamp, so every peer computes the identical sequence.
 * Each revision's `row` is the kernel's own fold up to that stamp — `max`/`min` columns
 * replay exactly as they merged, not as they arrived.
 */
export function rowHistory<T extends Table>(
  table: T,
  key: RowKey,
  entries: readonly StoredEvent[],
  options: HistoryOptions,
): readonly Revision<T>[] {
  const touching: Touch[] = [];
  for (const { event } of entries) {
    if (options.partition !== undefined && event.partition !== options.partition) continue;
    const changes = event.changes.filter((c) => c.table === table.name && c.key === key);
    if (changes.length > 0) touching.push({ event, changes });
  }
  touching.sort((a, b) => compareStamp(stampOf(a.event), stampOf(b.event)));

  let state = emptyState();
  const revisions: Revision<T>[] = [];
  for (const { event, changes } of touching) {
    for (const change of changes) {
      // a change this build cannot fold still belongs in the history — a write happened here, and
      // saying so is more use to a person than a gap where one was (D22-A)
      if (foldable(change))
        state = applyChange(state, change, stampOf(event), options.merge, event.partition);
      const cells = readRow(state, table.name, key);
      revisions.push({
        at: event.hlc[0],
        by: options.accountOf(event.peerId),
        peerId: event.peerId,
        eventId: event.id,
        procedure: String(event.procedure),
        kind: change.kind,
        changed:
          change.kind === "delete" || change.kind === "unknown" || change.kind === "doc"
            ? {}
            : fromWirePatch(table, change.kind === "insert" ? change.row : change.patch),
        row: cells === undefined ? null : fromWireRow(table, cells),
      });
    }
  }
  return revisions;
}

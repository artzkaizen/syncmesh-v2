import type { Change, RowKey, Stamp, SyncEvent, TableName } from "@syncmesh/kernel";
import type { BlobHash, BlobRow } from "@syncmesh/storage";

import { compareStamp, eventStamp } from "@syncmesh/kernel";
import { blobNamesIn, laterStamp } from "@syncmesh/storage";

/** One row that has named a blob, as this relay has seen it written and deleted. */
interface Tracked {
  readonly table: TableName;
  readonly key: RowKey;
  readonly hashes: Set<BlobHash>;
  written: Stamp | undefined;
  deleted: Stamp | undefined;
}

/** Live as the kernel's record is: written, and written after its latest delete. */
const isLive = (row: Tracked): boolean =>
  row.written !== undefined &&
  (row.deleted === undefined || compareStamp(row.written, row.deleted) > 0);

/** The names one change could reference: in the cells it writes, or the payload a newer build wrote. */
function changeNames(change: Change): readonly BlobHash[] {
  if (change.kind === "insert") return [...blobNamesIn([...change.row.values()])];
  if (change.kind === "update") return [...blobNamesIn([...change.patch.values()])];
  if (change.kind === "unknown") return [...blobNamesIn(change.data)];
  return [];
}

const rowId = (table: TableName, key: RowKey): string => JSON.stringify([table, key]);

/**
 * Which blobs the rows a relay has seen still name (gaps U18) — a fold of row existence only, the
 * one part of the kernel's record a relay can follow without a schema. A row is tracked from the
 * first write that names a blob; every later write to it moves its write stamp, and a delete its
 * delete stamp, by the same max-joins the kernel uses, so the order events arrive in changes
 * nothing. A name is referenced while any live row carried it.
 *
 * What it does not follow, each in the keeping direction:
 * - **A cell written over is still a reference.** Whether a newer write replaced a cell depends on
 *   the column's merge rule, which the relay does not know; only the row's delete releases.
 * - **A delete of a row not yet tracked is not remembered.** An insert that arrives after a newer
 *   delete of its row, with nothing between them naming a blob, makes a live row here.
 * - **A delete undone by a later write brings every name back**, as the kernel brings the row's
 *   cells back — which is why a released name is kept for the window rather than freed at once.
 */
export function createBlobReferences() {
  const rows = new Map<string, Tracked>();
  /** Rows changed since the last {@link taken}: what the ledger has not been told yet. */
  const dirty = new Set<string>();

  const track = (table: TableName, key: RowKey): Tracked => {
    const id = rowId(table, key);
    const found = rows.get(id);
    if (found !== undefined) return found;
    const fresh: Tracked = {
      table,
      key,
      hashes: new Set(),
      written: undefined,
      deleted: undefined,
    };
    rows.set(id, fresh);
    return fresh;
  };

  return {
    /** Rows a ledger kept, joined into what is held — the same joins a note makes. */
    restore: (saved: readonly BlobRow[]): void => {
      for (const row of saved) {
        const held = track(row.table, row.key);
        for (const hash of row.hashes) held.hashes.add(hash);
        held.written = laterStamp(held.written, row.written);
        held.deleted = laterStamp(held.deleted, row.deleted);
      }
    },
    /**
     * Folds one event's row changes; answers the names a delete just stopped this event's rows
     * referencing, so the window before their sweep can start from now.
     */
    note: (event: SyncEvent): readonly BlobHash[] => {
      const stamp = eventStamp(event);
      const released: BlobHash[] = [];
      for (const change of event.changes) {
        if (change.kind === "doc") continue;
        const id = rowId(change.table, change.key);
        const names = changeNames(change);
        if (!rows.has(id) && names.length === 0) continue;
        const row = track(change.table, change.key);
        const was = isLive(row);
        for (const name of names) row.hashes.add(name);
        if (change.kind === "delete") row.deleted = laterStamp(row.deleted, stamp);
        else row.written = laterStamp(row.written, stamp);
        dirty.add(id);
        if (was && !isLive(row)) released.push(...row.hashes);
      }
      return released;
    },
    /** Every name a live row carries. */
    referenced: (): ReadonlySet<BlobHash> => {
      const names = new Set<BlobHash>();
      for (const row of rows.values())
        if (isLive(row)) for (const name of row.hashes) names.add(name);
      return names;
    },
    /** The rows changed since the last call, as a ledger keeps them; `retake` them on a failed save. */
    taken: (): readonly BlobRow[] => {
      const out: BlobRow[] = [];
      for (const id of dirty) {
        const row = rows.get(id);
        if (row !== undefined)
          out.push({
            table: row.table,
            key: row.key,
            hashes: [...row.hashes],
            written: row.written,
            deleted: row.deleted,
          });
      }
      dirty.clear();
      return out;
    },
    /** Marks rows dirty again — a save that failed must be retried with them. */
    retake: (rowsBack: readonly BlobRow[]): void => {
      for (const row of rowsBack) dirty.add(rowId(row.table, row.key));
    },
    size: (): number => rows.size,
  };
}

export type BlobReferences = ReturnType<typeof createBlobReferences>;

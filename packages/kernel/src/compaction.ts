import type { RowKey, TableName } from "./change.js";
import type { Hlc } from "./hlc.js";
import type { Cell, ColumnName, JsonValue, RowRecord } from "./record.js";
import type { State, TableState } from "./state.js";
import type { MergeSpec, StrategyName } from "./strategy.js";

import { compareHlc } from "./hlc.js";
import { readSet } from "./set.js";

/**
 * One OR-Set cell with its tombstones dropped, or the cell unchanged when it is not yet safe to
 * drop them — the bound a `set` column otherwise lacks, since every removed id keeps
 * an empty entry for the life of the row.
 *
 * `stable` is a **causal stability frontier**: every event anywhere in the mesh whose HLC is at or
 * below it has been delivered to every peer still counted, and a peer that returns below it rejoins
 * from state rather than from those events (RFC-0015 §2, §3). The rule is then one comparison —
 * *the whole cell*, not one entry — and that is what makes it safe rather than a resurrection bug:
 *
 * - Every write this cell ever took is at or below its stamp. If the stamp is stable, every one of
 *   them has reached every peer, so **no peer still holds a dropped id as a live element**, and
 *   none can hand it back at the next merge.
 * - Dropping one entry on its own id's stamp would not have that property. The id carries the
 *   *add*'s stamp; a peer that has the add and not yet the remove holds the element live, and
 *   would resurrect it against a peer that had already dropped the tombstone.
 *
 * The price is that a cell written constantly never has a stable stamp and so never compacts. It
 * compacts when it goes quiet, which is when the ids it is carrying are dead weight anyway. Making
 * a churning cell compact needs the *remove*'s stamp per entry, which the entry does not carry.
 *
 * **This is not a lattice join, and its result is not a merge of its input.** Dropping an entry
 * moves the cell *down*: a peer that has compacted and one that has not hold different cells for
 * the same row and digest differently until both have, and a merge between the two puts the
 * tombstones back — to be dropped again, since the stamp does not move. The caller owes the
 * frontier; nothing here can check it.
 */
export function compactSetCell(cell: Cell, stable: Hlc): Cell {
  if (compareHlc(cell.stamp.hlc, stable) > 0) return cell;
  const state = readSet(cell.value);
  const live: Record<string, readonly JsonValue[]> = {};
  let dropped = 0;
  for (const tag of Object.keys(state)) {
    const entry = state[tag] ?? [];
    if (entry.length === 0) dropped += 1;
    else live[tag] = entry;
  }
  return dropped === 0 ? cell : { stamp: cell.stamp, value: live };
}

/** The columns `merge` gives the named strategy in one table. */
const columnsWith = (
  rules: ReadonlyMap<ColumnName, StrategyName> | undefined,
  strategy: StrategyName,
): readonly ColumnName[] =>
  rules === undefined ? [] : [...rules].filter(([, s]) => s === strategy).map(([c]) => c);

function compactRecord(record: RowRecord, columns: readonly ColumnName[], stable: Hlc): RowRecord {
  let cells: Map<ColumnName, Cell> | undefined;
  for (const column of columns) {
    const cell = record.cells.get(column);
    if (cell === undefined) continue;
    const compacted = compactSetCell(cell, stable);
    if (compacted === cell) continue;
    cells ??= new Map(record.cells);
    cells.set(column, compacted);
  }
  return cells === undefined ? record : { ...record, cells };
}

function compactTable(rows: TableState, columns: readonly ColumnName[], stable: Hlc): TableState {
  let next: Map<RowKey, RowRecord> | undefined;
  for (const [key, record] of rows) {
    const compacted = compactRecord(record, columns, stable);
    if (compacted === record) continue;
    next ??= new Map(rows);
    next.set(key, compacted);
  }
  return next ?? rows;
}

/**
 * Every `set` column in the state, compacted against one frontier; the state itself when nothing
 * was dropped, so a caller can tell a no-op by identity.
 *
 * `merge` is what says which columns are sets — the same spec the fold merges by, so a column can
 * only be compacted as a set if it is also joined as one. It carries {@link compactSetCell}'s
 * precondition unchanged: applying a frontier to a device's state without applying it to the
 * snapshot that device serves would hand a joiner the tombstones straight back.
 */
export function compactSets(state: State, merge: MergeSpec, stable: Hlc): State {
  let next: Map<TableName, TableState> | undefined;
  for (const [table, rows] of state) {
    const columns = columnsWith(merge.get(table), "set");
    if (columns.length === 0) continue;
    const compacted = compactTable(rows, columns, stable);
    if (compacted === rows) continue;
    next ??= new Map(state);
    next.set(table, compacted);
  }
  return next ?? state;
}

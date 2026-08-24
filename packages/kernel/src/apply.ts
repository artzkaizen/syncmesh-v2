import type { Change, Row, RowKey, TableName } from "./change.js";
import type { Cell, ColumnName, RowRecord } from "./record.js";
import type { State, TableState } from "./state.js";

import { compareStamp, type Stamp } from "./stamp.js";
import { strategies, type MergeSpec, type Strategy } from "./strategy.js";

const later = (a: Stamp | undefined, b: Stamp): Stamp =>
  a !== undefined && compareStamp(a, b) > 0 ? a : b;

const EMPTY_RECORD: RowRecord = { cells: new Map() };

/**
 * Folds one change into the state and returns the new state; the input is untouched.
 *
 * Every step is a max-based join — cells by their column's strategy, `writeStamp` and
 * `deleteStamp` by stamp — so any order and any replay of the same changes converge.
 * `insert` and `update` both merge column by column (RFC-0014 §1); `merge` names the
 * strategy per column, defaulting to `lww`.
 */
export function applyChange(state: State, change: Change, stamp: Stamp, merge?: MergeSpec): State {
  const table = state.get(change.table) ?? new Map<RowKey, RowRecord>();
  const current = table.get(change.key) ?? EMPTY_RECORD;
  const next =
    change.kind === "delete"
      ? { ...current, deleteStamp: later(current.deleteStamp, stamp) }
      : {
          ...current,
          cells: mergeCells(
            current.cells,
            change.kind === "insert" ? change.row : change.patch,
            stamp,
            merge?.get(change.table),
          ),
          writeStamp: later(current.writeStamp, stamp),
        };
  return withRecord(state, change.table, table, change.key, next);
}

function mergeCells(
  current: ReadonlyMap<ColumnName, Cell>,
  incoming: Row,
  stamp: Stamp,
  columnStrategies: ReadonlyMap<ColumnName, keyof typeof strategies> | undefined,
): ReadonlyMap<ColumnName, Cell> {
  const cells = new Map(current);
  for (const [column, value] of incoming) {
    const candidate: Cell = { value, stamp };
    const existing = cells.get(column);
    const strategy: Strategy = strategies[columnStrategies?.get(column) ?? "lww"];
    cells.set(column, existing === undefined ? candidate : strategy(candidate, existing));
  }
  return cells;
}

function withRecord(
  state: State,
  name: TableName,
  table: TableState,
  key: RowKey,
  record: RowRecord,
): State {
  const nextTable = new Map(table);
  nextTable.set(key, record);
  const nextState = new Map(state);
  nextState.set(name, nextTable);
  return nextState;
}

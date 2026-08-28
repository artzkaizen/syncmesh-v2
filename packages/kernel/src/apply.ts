import type { FoldableChange, Row, RowKey, TableName } from "./change.js";
import type { PartitionKey } from "./partition.js";
import type { Cell, ColumnName, RowRecord } from "./record.js";
import type { State, TableState } from "./state.js";

import { compareStamp, type Stamp } from "./stamp.js";
import { strategies, type MergeSpec, type StrategyName } from "./strategy.js";

type ColumnStrategies = ReadonlyMap<ColumnName, StrategyName> | undefined;

const later = (a: Stamp | undefined, b: Stamp | undefined): Stamp | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareStamp(a, b) > 0 ? a : b;
};

const EMPTY_RECORD: RowRecord = { cells: new Map() };

/**
 * Folds one change into the state and returns the new state; the input is untouched.
 *
 * Every step is a max-based join — cells by their column's strategy, `writeStamp` and
 * `deleteStamp` by stamp — so any order and any replay of the same changes converge.
 * `insert` and `update` both merge column by column (RFC-0014 §1); `merge` names the
 * strategy per column, defaulting to `lww`. `partition` is the event's; a row keeps the first it saw.
 */
export function applyChange(
  state: State,
  change: FoldableChange,
  stamp: Stamp,
  merge?: MergeSpec,
  partition?: PartitionKey,
): State {
  const base: RowRecord =
    change.kind === "delete"
      ? { cells: new Map(), deleteStamp: stamp }
      : {
          cells: stampAll(change.kind === "insert" ? change.row : change.patch, stamp),
          writeStamp: stamp,
        };
  const incoming = partition === undefined ? base : { ...base, partition };
  return mergeRecord(state, change.table, change.key, incoming, merge);
}

/** Joins a whole record — a snapshot row — into the state; equivalent to folding its cells and stamps as changes. */
export function mergeRecord(
  state: State,
  table: TableName,
  key: RowKey,
  record: RowRecord,
  merge?: MergeSpec,
): State {
  const tableState = state.get(table) ?? new Map<RowKey, RowRecord>();
  const current = tableState.get(key) ?? EMPTY_RECORD;
  const partition = current.partition ?? record.partition;
  const joined = {
    cells: mergeCells(current.cells, record.cells, merge?.get(table)),
    ...stampFields(
      later(current.writeStamp, record.writeStamp),
      later(current.deleteStamp, record.deleteStamp),
    ),
  };
  return withRecord(
    state,
    table,
    tableState,
    key,
    partition === undefined ? joined : { ...joined, partition },
  );
}

const stampAll = (row: Row, stamp: Stamp): ReadonlyMap<ColumnName, Cell> =>
  new Map([...row].map(([column, value]) => [column, { value, stamp }]));

function mergeCells(
  current: ReadonlyMap<ColumnName, Cell>,
  incoming: ReadonlyMap<ColumnName, Cell>,
  columnStrategies: ColumnStrategies,
): ReadonlyMap<ColumnName, Cell> {
  const cells = new Map(current);
  for (const [column, candidate] of incoming) {
    const existing = cells.get(column);
    const strategy = strategies[columnStrategies?.get(column) ?? "lastWrite"];
    // Joining a first arrival with itself is the identity for `lww`, `max` and `min`, and puts a
    // `counter` or `set` cell into its normal form. Storing it raw instead would leave the shape a
    // sender happened to send in the state, and two peers would digest the same set differently.
    cells.set(column, strategy(candidate, existing ?? candidate));
  }
  return cells;
}

function stampFields(
  writeStamp: Stamp | undefined,
  deleteStamp: Stamp | undefined,
): Pick<RowRecord, "writeStamp" | "deleteStamp"> {
  if (writeStamp !== undefined && deleteStamp !== undefined) return { writeStamp, deleteStamp };
  if (writeStamp !== undefined) return { writeStamp };
  if (deleteStamp !== undefined) return { deleteStamp };
  return {};
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

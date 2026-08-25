import type { Row, RowKey, TableName } from "./change.js";
import type { PartitionKey } from "./partition.js";

import { isVisible, type RowRecord } from "./record.js";

export type TableState = ReadonlyMap<RowKey, RowRecord>;

export type State = ReadonlyMap<TableName, TableState>;

export const emptyState = (): State => new Map();

export function getRecord(state: State, table: TableName, key: RowKey): RowRecord | undefined {
  return state.get(table)?.get(key);
}

/** The row's current values, or `undefined` when it is absent or deleted. */
export function readRow(state: State, table: TableName, key: RowKey): Row | undefined {
  const record = getRecord(state, table, key);
  if (record === undefined || !isVisible(record)) return undefined;
  return values(record);
}

/** Every visible row of the table. */
export function readRows(state: State, table: TableName): ReadonlyMap<RowKey, Row> {
  const rows = new Map<RowKey, Row>();
  for (const [key, record] of state.get(table) ?? [])
    if (isVisible(record)) rows.set(key, values(record));
  return rows;
}

/** Every visible row of the table that belongs to `partition`. */
export function readRowsIn(
  state: State,
  table: TableName,
  partition: PartitionKey,
): ReadonlyMap<RowKey, Row> {
  const rows = new Map<RowKey, Row>();
  for (const [key, record] of state.get(table) ?? []) {
    if (record.partition === partition && isVisible(record)) rows.set(key, values(record));
  }
  return rows;
}

const values = (record: RowRecord): Row =>
  new Map([...record.cells].map(([column, cell]) => [column, cell.value]));

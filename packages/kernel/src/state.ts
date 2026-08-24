import type { Row, RowKey, TableName } from "./change.js";

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
  return new Map([...record.cells].map(([column, cell]) => [column, cell.value]));
}

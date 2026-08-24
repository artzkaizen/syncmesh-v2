import type { Change, Row, RowKey, TableName } from "@syncmesh/kernel";

export interface Tx {
  readonly insert: (table: TableName, key: RowKey, row: Row) => void;
  readonly update: (table: TableName, key: RowKey, patch: Row) => void;
  readonly delete: (table: TableName, key: RowKey) => void;
}

/** Runs `fn` against a `Tx` that only records; returns the changes in call order. */
export function record(fn: (tx: Tx) => void): readonly Change[] {
  const changes: Change[] = [];
  fn({
    insert: (table, key, row) => changes.push({ kind: "insert", table, key, row }),
    update: (table, key, patch) => changes.push({ kind: "update", table, key, patch }),
    delete: (table, key) => changes.push({ kind: "delete", table, key }),
  });
  return changes;
}

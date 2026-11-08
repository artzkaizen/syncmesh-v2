import type { Change, DocChange, Row, RowKey, TableName } from "@syncmesh/kernel";

/**
 * A document update as a mutation records it: everything but where it goes. A genesis names no
 * lineage of its own — the engine derives it once the event is numbered (RFC-0023 §5.3), since the
 * derivation is over the event's id and the change's place in it, neither of which exists yet.
 */
export type DocWrite = Omit<DocChange, "kind" | "table" | "key">;

export interface Tx {
  readonly insert: (table: TableName, key: RowKey, row: Row) => void;
  readonly update: (table: TableName, key: RowKey, patch: Row) => void;
  readonly delete: (table: TableName, key: RowKey) => void;
  /** Appends one update to a document column; the row's own cells are untouched. */
  readonly doc: (table: TableName, key: RowKey, write: DocWrite) => void;
}

/** The write a doc change was recorded from — what a replay records again. */
export const docWriteOf = ({
  kind: _kind,
  table: _table,
  key: _key,
  ...write
}: DocChange): DocWrite => write;

/** Runs `fn` against a `Tx` that only records; returns the changes in call order. */
export function record(fn: (tx: Tx) => void): readonly Change[] {
  const changes: Change[] = [];
  fn({
    insert: (table, key, row) => changes.push({ kind: "insert", table, key, row }),
    update: (table, key, patch) => changes.push({ kind: "update", table, key, patch }),
    delete: (table, key) => changes.push({ kind: "delete", table, key }),
    doc: (table, key, write) => changes.push({ kind: "doc", table, key, ...write }),
  });
  return changes;
}

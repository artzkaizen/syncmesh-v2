import type { CellValue, ColumnName, PartitionKey, Row, RowKey } from "@syncmesh/kernel";
import type { Table } from "@syncmesh/schema";

import { parsePartitionKey } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { rowKeyText } from "@syncmesh/schema";

import type { SourceRow } from "./source.js";

import { RowUnplaceable, RowUnreadable } from "./errors.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- a row key is a brand over the text the source's own key column holds */
export const rowKey = (value: string): RowKey => value as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** Which collection one database table feeds, and how a row of it finds the instance it lives in. */
export interface ChangeMapping {
  /**
   * The collection the table feeds — the mesh's existing definition of it, never a second one.
   * Its primary key names the key column; its columns name which of the source's are published.
   */
  readonly collection: Table;
  /**
   * The instance a row belongs to, read from the row the database sent: `` `org:${row.org_id}` ``.
   * Config and not a column for now, so a table can be published without a migration; a column
   * the database owns is the auditable alternative and stays open (RFC-0021).
   */
  readonly partition: (row: SourceRow) => string | undefined;
}

/** Keyed by the database's own table name. A table absent from here never leaves the database. */
export type ChangeMappings = Readonly<Record<string, ChangeMapping>>;

/**
 * The source's row as the collection's cells: every column the manifest declares, and nothing
 * else. A column the database grew is dropped here rather than carried, which is what keeps a
 * migration on their side from becoming a schema violation on ours — the DDL alarm is where a
 * shape change is meant to be heard. A column the manifest declares and the row lacks is left
 * absent, which the schema check refuses on insert if it was not nullable.
 */
export function meshCells(collection: Table, row: SourceRow): Row {
  const cells = new Map<ColumnName, CellValue>();
  for (const [key, name] of Object.entries(collection.columnNames)) {
    const value = row[key];
    if (value !== undefined) cells.set(name, value);
  }
  return cells;
}

/** The key an inserted row is filed under: its primary-key cell, checked against that column. */
export function meshKey(collection: Table, row: SourceRow): Result<RowKey, RowUnreadable> {
  return rowKeyText(collection, row)
    .map(rowKey)
    .mapError(
      (cause) =>
        new RowUnreadable({
          table: String(collection.name),
          cause,
          message: `${String(collection.name)}: ${cause.message}`,
        }),
    );
}

/**
 * Where the mapping says this row lives. A row nobody can place is refused rather than skipped:
 * silently dropping it leaves the database holding a row the mesh will never hear about again,
 * and no later change can repair that because CDC only ever carries what changed next.
 */
export function partitionOf(
  table: string,
  key: RowKey,
  mapping: ChangeMapping,
  row: SourceRow,
): Result<PartitionKey, RowUnplaceable> {
  const named = mapping.partition(row);
  const parsed = named === undefined ? undefined : parsePartitionKey(named);
  if (parsed === undefined || parsed.isErr()) {
    return Result.err(
      new RowUnplaceable({
        table,
        key: String(key),
        message:
          named === undefined
            ? "the mapping placed this row in no instance"
            : `"${named}" is not a kind:id instance`,
      }),
    );
  }
  return Result.ok(parsed.value);
}

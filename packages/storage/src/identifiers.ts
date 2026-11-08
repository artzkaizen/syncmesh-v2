import type { ColumnName, TableName } from "@syncmesh/kernel";
import type { Table } from "@syncmesh/schema";

/*
 * Every identifier below reaches the SQL as a parsed brand — TableName / ColumnName, grammar
 * `^[a-z][a-zA-Z0-9_]{0,63}$`, refused by the schema before a table exists — never as a raw
 * string, and no row or caller value is ever interpolated: DDL cannot take bind parameters, so
 * validated, quoted identifiers are the whole defence, the same one `sql.identifier` gives.
 */
export const quote = (name: TableName | ColumnName) => `"${String(name).replaceAll('"', '""')}"`;
export const literal = (name: TableName) => `'${String(name).replaceAll("'", "''")}'`;

/** The table's columns as `[key, brand, column]`; a key `table()` did not validate has no brand and is skipped. */
export const columnsOf = (table: Table) =>
  Object.entries(table.columns).flatMap(([key, column]) => {
    const name = table.columnNames[key];
    return name === undefined ? [] : [[key, name, column] as const];
  });

/**
 * The columns whose values the fold carries: every column but a document's. A document column's
 * cell holds its lineage (RFC-0023 §6.1), not the bytes the app reads, so the projection never
 * writes it and capture never logs a change to it — the materialiser owns that column.
 */
export const valueColumns = (table: Table) =>
  columnsOf(table).filter(([, , column]) => column.def.doc === undefined);

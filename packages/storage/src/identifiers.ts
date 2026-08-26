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

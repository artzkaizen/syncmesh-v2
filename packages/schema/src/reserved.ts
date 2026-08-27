import type { ColumnName } from "@syncmesh/kernel";

import { panic } from "@syncmesh/result";

import type { Columns, PrimaryKey, Table } from "./table.js";

import { t } from "./column.js";
import { parseColumnName, reservedTableName } from "./names.js";

/** A table the manifest installs under a `_` name; never reachable through `table()`. */
export function reservedTable<const C extends Columns>(
  name: string,
  columns: C,
): Table<C, PrimaryKey<C>> {
  const parsedName = reservedTableName(name);
  if (parsedName.isErr()) panic(`${name}: ${parsedName.error.message}`);
  const columnNames: Record<string, ColumnName> = {};
  for (const key of Object.keys(columns)) {
    const parsed = parseColumnName(key);
    if (parsed.isErr()) panic(`${name}.${key}: ${parsed.error.message}`);
    columnNames[key] = parsed.value;
  }
  const primaryKeys = Object.entries(columns)
    .filter(([, c]) => c.def.primaryKey)
    .map(([k]) => k);
  if (primaryKeys.length !== 1) panic(`${name}: expected exactly one primaryKey column`);
  // SAFETY: exactly one primary key was found and it is a key of C; columnNames was built from Object.keys(columns)
  return {
    name: parsedName.value,
    columns,
    primaryKey: primaryKeys[0] as PrimaryKey<C>,
    columnNames: columnNames as Table<C>["columnNames"],
  };
}

/** The synced policy row: the manifest's rules as data, so every peer runs the same ones (RFC-0008). */
export const policyTable = reservedTable("_policy", {
  id: t.text().primaryKey(),
  rules: t.json(),
  version: t.integer(),
});

/** An authority's overwrite together with its reason, as one signed row (RFC-0014 §4). */
export const correctionsTable = reservedTable("_corrections", {
  id: t.text().primaryKey(),
  eventId: t.text(),
  table: t.text(),
  key: t.text(),
  reason: t.text(),
  detail: t.json().nullable(),
});

/**
 * A device's powers withdrawn, as one signed row in the instance it concerns (RFC-0016). Keyed
 * by `instance:device`, because a device removed from one org keeps whatever it holds elsewhere.
 */
export const revocationsTable = reservedTable("_revocations", {
  id: t.text().primaryKey(),
  /** Epoch milliseconds. A grant issued after this instant is unaffected — re-issuing readmits. */
  at: t.integer(),
  reason: t.text(),
});

export const reservedTables = [policyTable, correctionsTable, revocationsTable] as const;

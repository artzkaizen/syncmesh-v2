import type { PeerId } from "@syncmesh/kernel";
import type { SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import { ROW_SYNC, operationOfSql, syncOfSql } from "@syncmesh/storage";
import { getTableColumns, getTableName, sql } from "drizzle-orm";

/**
 * Where this row's own write got to, as a column the handler selects (book ch. 10).
 *
 * ```ts
 * db.select({ ...columns(products), sync: syncOf(products) }).from(products)
 * ```
 *
 * Not framework magic on the result — a column, exactly like `name`. A query whose handler never
 * selects it returns rows with no `.sync`, and the type says so; it also never re-runs when an
 * acknowledgement lands, which is the whole reason this is opt-in per query rather than a field
 * every row carries.
 */
export type SyncState = "local" | "delivered" | "remote";

/** The table's own columns, for spreading beside a selected `syncOf`. */
export const columns = <T extends PgTable | SQLiteTable>(table: T) => getTableColumns(table);

export function syncOf(self: PeerId, table: PgTable | SQLiteTable): SQL<SyncState | null> {
  const name = getTableName(table);
  const primary = primaryKeyOf(table);
  const correlated = sql.raw(syncOfSql(self, name, `${quoteIdent(name)}.${quoteIdent(primary)}`));
  // SAFETY: the CASE has three arms and every one of them is a SyncState; a row the table has no
  // sync entry for yields NULL, which is why the column is nullable rather than total
  return correlated as SQL<SyncState | null>;
}

/** The name the row-sync subquery correlates on; a query that selects `syncOf` names this table. */
export const ROW_SYNC_TABLE = ROW_SYNC;

/**
 * The row's pending operation id — the join key into `$operations` (book ch. 10), where the
 * receipts, the blockers and any correction's reason live.
 *
 * ```ts
 * db.select({ ...columns(products), op: operationOf(products, "sqlite") }).from(products)
 * ```
 *
 * There is deliberately no `correctionOf` beside it. A correction's *why* matters to the author
 * of the displaced write and renders on their operation record; to a reader who never wrote the
 * old value, the corrected value is simply the value. Where the why must be public forever, it
 * is data — a column, or an audit row the correction also writes.
 */
export function operationOf(
  table: PgTable | SQLiteTable,
  dialect: "sqlite" | "postgres" = "sqlite",
): SQL<string | null> {
  const name = getTableName(table);
  const ledger = dialect === "postgres" ? "_syncmesh_operations" : "operations";
  const correlated = sql.raw(
    operationOfSql(name, `${quoteIdent(name)}.${quoteIdent(primaryKeyOf(table))}`, ledger),
  );
  // SAFETY: the subquery selects the ledger's own text id, or NULL where the row has no record —
  // a peer's write, or one made before this device kept a ledger
  return correlated as SQL<string | null>;
}

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * The column the sync state is keyed by. Drizzle names a primary key on the column itself, so
 * this reads it back rather than being told — the handler already named the table, and naming
 * its key again is the string coordinate this whole column exists to delete.
 */
function primaryKeyOf(table: PgTable | SQLiteTable): string {
  for (const [, column] of Object.entries(getTableColumns(table))) {
    if (column.primary) return column.name;
  }
  return "id";
}

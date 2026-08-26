import type { RowWrite } from "@syncmesh/engine";
import type { CellValue } from "@syncmesh/kernel";
import type { ColumnKind, Table } from "@syncmesh/schema";

import { isVisible } from "@syncmesh/kernel";

import type { SqlValue, SqliteDriver } from "./driver.js";

import { columnsOf, quote } from "./identifiers.js";

/** A cell in the form the column's SQL type holds it. */
const sqlValueOf = (kind: ColumnKind, cell: CellValue): SqlValue => {
  if (cell === null) return null;
  if (cell instanceof Uint8Array) return cell;
  switch (kind) {
    case "boolean":
      return cell === true ? 1 : 0;
    case "json":
      return JSON.stringify(cell);
    case "integer":
    case "float":
    case "timestamp":
      return Number(cell);
    default:
      // SAFETY: a text or uuid cell passed the column's kind check when it was written, so it is a string
      return cell as string;
  }
};

/** What the fold writes into the app's tables: the state store's projection, applied inside its own commit. */
export interface Projection {
  readonly apply: (rows: readonly RowWrite[]) => Promise<void>;
  readonly clear: () => Promise<void>;
}

/**
 * The fold's side of the two writers (D20): a visible record is UPSERTed into its table, a
 * tombstoned one deleted, with the capture guard at rest so none of it is logged as the app's
 * own. Stamps stay in the sidecar; the app's tables hold values only.
 */
export function tablesProjection(driver: SqliteDriver, tables: readonly Table[]): Projection {
  const byName = new Map(tables.map((t) => [String(t.name), t]));
  const statements = new Map(
    tables.map((table) => {
      const columns = columnsOf(table);
      const names = [...columns.map(([, name]) => quote(name)), '"_partition"'];
      const pk = table.columnNames[table.primaryKey];
      const updates = names.map((n) => `${n} = excluded.${n}`).join(", ");
      const upsert = `INSERT INTO ${quote(table.name)} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ON CONFLICT(${pk === undefined ? '"id"' : quote(pk)}) DO UPDATE SET ${updates}`;
      const remove = `DELETE FROM ${quote(table.name)} WHERE ${pk === undefined ? '"id"' : quote(pk)} = ?`;
      return [String(table.name), { columns, upsert, remove }] as const;
    }),
  );
  return {
    apply: async (rows) => {
      for (const { table, key, record } of rows) {
        const plan = statements.get(String(table));
        if (plan === undefined) continue;
        if (!isVisible(record)) {
          await driver.run(plan.remove, [String(key)]);
          continue;
        }
        const values = plan.columns.map(([, name, column]) =>
          sqlValueOf(column.def.kind, record.cells.get(name)?.value ?? null),
        );
        await driver.run(plan.upsert, [...values, record.partition ?? null]);
      }
    },
    clear: async () => {
      for (const table of byName.values()) await driver.run(`DELETE FROM ${quote(table.name)}`);
    },
  };
}

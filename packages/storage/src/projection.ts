import type { RowWrite } from "@syncmesh/engine";
import type { Table } from "@syncmesh/schema";

import { counterValue, isVisible } from "@syncmesh/kernel";

import type { SqlDriver } from "./driver.js";
import type { RowSync } from "./row-sync.js";

import { dialectOf } from "./dialect.js";
import { columnsOf, quote } from "./identifiers.js";

/** A cell in the form the column's SQL type holds it on SQLite — what the fold writes and what a compiled rule compares against. */

/** What the fold writes into the app's tables: the state store's projection, applied inside its own commit. */
export interface Projection {
  readonly apply: (rows: readonly RowWrite[]) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface ProjectionOptions {
  /**
   * Keeps the row-sync table in step with every fold, so `syncOf(table)` is a column a query
   * joins rather than a lookup an app correlates by hand (book ch. 10). Absent, the table is
   * left alone and a query that selects `syncOf` finds nothing.
   */
  readonly rowSync?: RowSync;
  /**
   * The column that receives each row's partition key. Default `_partition` — what `tableDdl`
   * creates on a device. `false` when your table has no such column: the key is then only in
   * the sidecar, and reads cannot be pinned to an instance.
   */
  readonly partitionColumn?: string | false;
}

/**
 * The fold's side of the two writers (D20): a visible record is UPSERTed into its table, a
 * tombstoned one deleted, with the capture guard at rest so none of it is logged as the app's
 * own. Stamps stay in the sidecar; the app's tables hold values only, in the driver's dialect.
 */
export function tablesProjection(
  driver: SqlDriver,
  tables: readonly Table[],
  options: ProjectionOptions = {},
): Projection {
  const dialect = dialectOf(driver);
  const partitionColumn = options.partitionColumn ?? "_partition";
  const byName = new Map(tables.map((t) => [String(t.name), t]));
  const statements = new Map(
    tables.map((table) => {
      const columns = columnsOf(table);
      const names = columns.map(([, name]) => quote(name));
      // the partition column is the mesh's own, never a schema column: quoted like one
      if (partitionColumn !== false) names.push(`"${partitionColumn.replaceAll('"', '""')}"`);
      const pk = table.columnNames[table.primaryKey];
      const key = pk === undefined ? '"id"' : quote(pk);
      const updates = names.map((n) => `${n} = excluded.${n}`).join(", ");
      const marks = names.map((_, i) => dialect.placeholder(i + 1)).join(", ");
      const upsert = `INSERT INTO ${quote(table.name)} (${names.join(", ")}) VALUES (${marks}) ON CONFLICT(${key}) DO UPDATE SET ${updates}`;
      const remove = `DELETE FROM ${quote(table.name)} WHERE ${key} = ${dialect.placeholder(1)}`;
      return [String(table.name), { columns, upsert, remove }] as const;
    }),
  );
  const rowSync = options.rowSync;
  return {
    apply: async (rows) => {
      // the same commit the rows land in: a query cannot see a row without its sync state
      await rowSync?.apply(rows);
      for (const { table, key, record } of rows) {
        const plan = statements.get(String(table));
        if (plan === undefined) continue;
        if (!isVisible(record)) {
          await driver.run(plan.remove, [String(key)]);
          continue;
        }
        const values = plan.columns.map(([, name, column]) => {
          const held = record.cells.get(name)?.value ?? null;
          // a counter cell stores per-author totals; the app's table holds the read — their sum
          const value = column.def.merge === "counter" && held !== null ? counterValue(held) : held;
          return dialect.cell(column.def.kind, value);
        });
        if (partitionColumn !== false) values.push(record.partition ?? null);
        await driver.run(plan.upsert, values);
      }
    },
    clear: async () => {
      await rowSync?.clear();
      for (const table of byName.values()) await driver.run(`DELETE FROM ${quote(table.name)}`);
    },
  };
}

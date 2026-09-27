import type { SuiteCase } from "@syncmesh/engine";

import { equal } from "@syncmesh/engine";

import type { SqlDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { sqlDocStore } from "../doc-store.js";

/** One column as the database reports it: name, SQL type, NOT NULL. */
type Described = readonly [string, string, boolean];

/**
 * The migrated table as the database itself describes it: its columns in order, its primary key,
 * and its secondary indexes with their columns. What the Drizzle declaration is compared against.
 */
async function describe(driver: SqlDriver, table: string) {
  if (driver.dialect === "postgres") {
    const columns = await driver.all(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = current_schema() ORDER BY ordinal_position`,
      [table],
    );
    const keyed = await driver.all(
      `SELECT i.relname, ix.indisprimary, a.attname FROM pg_class t
        JOIN pg_index ix ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        WHERE t.relname = $1 AND t.relnamespace = to_regnamespace(current_schema())
        ORDER BY i.relname, array_position(ix.indkey::int2[], a.attnum)`,
      [table],
    );
    const pk = keyed.filter(([, primary]) => primary === true).map(([, , name]) => String(name));
    const indexes = new Map<string, string[]>();
    for (const [name, primary, column] of keyed)
      if (primary !== true)
        indexes.set(String(name), [...(indexes.get(String(name)) ?? []), String(column)]);
    return {
      columns: columns.map(([name, type, nullable]): Described => [
        String(name),
        String(type),
        nullable === "NO",
      ]),
      pk,
      indexes: [...indexes],
    };
  }
  const columns = await driver.all(`PRAGMA table_info(${table})`);
  const indexList = await driver.all(`PRAGMA index_list(${table})`);
  const indexes: [string, string[]][] = [];
  for (const [, name, , origin] of indexList) {
    if (origin !== "c") continue; // `pk` is the key itself, `u` a UNIQUE; only CREATE INDEX here
    const info = await driver.all(`PRAGMA index_info(${String(name)})`);
    indexes.push([String(name), info.map(([, , column]) => String(column))]);
  }
  return {
    columns: columns.map(([, name, type, notnull]): Described => [
      String(name),
      String(type).toLowerCase(),
      notnull === 1,
    ]),
    pk: columns
      .filter(([, , , , , pk]) => Number(pk) > 0)
      .sort((x, y) => Number(x[5]) - Number(y[5]))
      .map(([, name]) => String(name)),
    indexes,
  };
}

/** The same three facts, read off a Drizzle table declaration. */
async function declared(dialect: SqlDriver["dialect"], which: "log" | "heads") {
  const tables = await import("../doc-tables.js");
  const config =
    dialect === "postgres"
      ? (await import("drizzle-orm/pg-core")).getTableConfig(
          which === "log" ? tables.pgDocLog : tables.pgDocHeads,
        )
      : (await import("drizzle-orm/sqlite-core")).getTableConfig(
          which === "log" ? tables.sqliteDocLog : tables.sqliteDocHeads,
        );
  return {
    name: config.name,
    columns: config.columns.map((c): Described => [c.name, c.getSQLType(), c.notNull]),
    pk: config.primaryKeys.flatMap((k) => k.columns.map((c) => c.name)),
    indexes: config.indexes.map((i): [string, string[]] => [
      i.config.name ?? "",
      i.config.columns.map((c) => ("name" in c ? String(c.name) : "")),
    ]),
  };
}

/**
 * The doc tables a migration creates, against their Drizzle 1.0 declarations (RFC-0023 §6.2): the
 * same columns in the same order with the same SQL types and nullability, the same primary key,
 * the same secondary indexes. The declarations load lazily, so a driver suite run without
 * `drizzle-orm` installed fails this one case and no other.
 */
export const ddlCase = (openDriver: OpenDriver): SuiteCase => ({
  name: "docs: the migrated doc_log and doc_heads are exactly their Drizzle 1.0 declarations",
  run: async () => {
    const driver = await openDriver("docs-ddl");
    (await sqlDocStore(driver)).unwrap();
    for (const which of ["log", "heads"] as const) {
      const want = await declared(driver.dialect, which);
      const have = await describe(driver, want.name);
      for (const part of ["columns", "pk", "indexes"] as const)
        equal(JSON.stringify(have[part]), JSON.stringify(want[part]), `${want.name} ${part}`);
    }
  },
});

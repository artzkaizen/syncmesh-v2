import type { StoreFailure } from "@syncmesh/engine";
import type { CellValue, Change, ColumnName, Row, RowKey, TableName } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { ColumnKind, Table } from "@syncmesh/schema";

import { hexToBytes } from "@syncmesh/wire";

import type { SqlValue, SqliteDriver } from "./driver.js";

import { attempt, inTransaction } from "./sql.js";

/**
 * Change capture (D20): the app writes its tables with its ORM; triggers log every row's
 * before and after into `_syncmesh_changes`; at commit the log becomes the kernel changes one
 * event carries. Only the columns whose value changed enter an update, so concurrent edits to
 * different columns of one row both survive the merge.
 */

const CHANGES = "_syncmesh_changes";
const GUARD = "_syncmesh_capture";

/*
 * Every identifier below reaches the SQL as a parsed brand — TableName / ColumnName, grammar
 * `^[a-z][a-zA-Z0-9_]{0,63}$`, refused by the schema before a table exists — never as a raw
 * string, and no row or caller value is ever interpolated: DDL cannot take bind parameters, so
 * validated, quoted identifiers are the whole defence, the same one `sql.identifier` gives.
 */
const quote = (name: TableName | ColumnName) => `"${String(name).replaceAll('"', '""')}"`;
const literal = (name: TableName) => `'${String(name).replaceAll("'", "''")}'`;

/** The table's columns as `[key, brand, column]`; a key `table()` did not validate has no brand and is skipped. */
const columnsOf = (table: Table) =>
  Object.entries(table.columns).flatMap(([key, column]) => {
    const name = table.columnNames[key];
    return name === undefined ? [] : [[key, name, column] as const];
  });

const sqlType = (kind: ColumnKind): string => {
  switch (kind) {
    case "integer":
    case "timestamp":
    case "boolean":
      return "INTEGER";
    case "float":
      return "REAL";
    case "blob":
      return "BLOB";
    default:
      return "TEXT";
  }
};

/** `CREATE TABLE` for a synced table: one column per schema column, plus `_partition`. */
export function tableDdl(table: Table): string {
  const columns = columnsOf(table).map(([key, name, column]) => {
    const constraint =
      key === table.primaryKey ? " PRIMARY KEY" : column.def.nullable ? "" : " NOT NULL";
    return `${quote(name)} ${sqlType(column.def.kind)}${constraint}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${quote(table.name)} (${[...columns, '"_partition" TEXT'].join(", ")})`;
}

/**
 * The logged image of a row as one JSON object. Bytes travel as hex, since JSON cannot hold a
 * BLOB; a NULL stays NULL rather than becoming `hex(NULL)`, the empty string.
 */
const image = (table: Table, alias: "NEW" | "OLD"): string =>
  `json_object(${columnsOf(table)
    .map(([, name, column]) => {
      const cell = `${alias}.${quote(name)}`;
      // lower(): SQLite's hex() is uppercase and the wire's hex codec is lowercase-only
      const logged =
        column.def.kind === "blob"
          ? `CASE WHEN ${cell} IS NULL THEN NULL ELSE lower(hex(${cell})) END`
          : cell;
      return `'${String(name)}', ${logged}`;
    })
    .join(", ")})`;

/**
 * The log table, the guard row, and one trigger per operation per table. Triggers fire only while
 * the guard is armed, so the fold's own UPSERTs of received events are never re-captured.
 */
export function captureDdl(tables: readonly Table[]): readonly string[] {
  const armed = `(SELECT armed FROM ${GUARD} WHERE id = 1) = 1`;
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${CHANGES} (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, key TEXT NOT NULL, op TEXT NOT NULL, old TEXT, new TEXT)`,
    `CREATE TABLE IF NOT EXISTS ${GUARD} (id INTEGER PRIMARY KEY, armed INTEGER NOT NULL)`,
    `INSERT OR IGNORE INTO ${GUARD} (id, armed) VALUES (1, 0)`,
  ];
  for (const table of tables) {
    const name = literal(table.name);
    const pk = table.columnNames[table.primaryKey];
    if (pk === undefined) continue;
    const key = (alias: "NEW" | "OLD") => `CAST(${alias}.${quote(pk)} AS TEXT)`;
    const trigger = (op: "insert" | "update" | "delete", body: string) =>
      `CREATE TRIGGER IF NOT EXISTS "_syncmesh_${String(table.name)}_${op}" AFTER ${op.toUpperCase()} ON ${quote(table.name)} WHEN ${armed} BEGIN INSERT INTO ${CHANGES} (tbl, key, op, old, new) VALUES (${body}); END`;
    statements.push(
      trigger("insert", `${name}, ${key("NEW")}, 'insert', NULL, ${image(table, "NEW")}`),
      trigger(
        "update",
        `${name}, ${key("NEW")}, 'update', ${image(table, "OLD")}, ${image(table, "NEW")}`,
      ),
      trigger("delete", `${name}, ${key("OLD")}, 'delete', ${image(table, "OLD")}, NULL`),
    );
  }
  return statements;
}

/** Creates the tables and installs capture on them; a no-op when already installed. */
export function installCapture(
  driver: SqliteDriver,
  tables: readonly Table[],
): Promise<Result<void, StoreFailure>> {
  return attempt("could not install change capture", async () => {
    for (const table of tables) await driver.run(tableDdl(table));
    for (const sql of captureDdl(tables)) await driver.run(sql);
  });
}

/** One logged cell: `json_object()` only ever holds SQL scalars — a json column arrives as its text. */
type Logged = string | number | boolean | null;

/** What a trigger logged for one row: column name to its scalar. */
type Image = Readonly<Record<string, Logged>>;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- keys and names are brands over the strings the log holds */
const rowKey = (key: string): RowKey => key as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** A logged JSON value back to the cell the column kind means. */
function cellOf(kind: ColumnKind, value: Logged | undefined): CellValue {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case "boolean":
      return value === 1 || value === true;
    case "blob":
      return hexToBytes(String(value)).unwrap();
    case "json":
      // SAFETY: a json column holds JSON text, which the image carries as a string; its parse is a JSON value
      return JSON.parse(String(value)) as CellValue;
    case "integer":
    case "float":
    case "timestamp":
      return Number(value);
    default:
      return String(value);
  }
}

const same = (a: Logged | undefined, b: Logged | undefined) => a === b;

function cells(table: Table, imageOf: Image, only?: Image): Row {
  const row = new Map<ColumnName, CellValue>();
  for (const [key, name, column] of columnsOf(table)) {
    if (only !== undefined && same(imageOf[key], only[key])) continue;
    row.set(name, cellOf(column.def.kind, imageOf[key]));
  }
  return row;
}

/** One log row to the change it records; an update that changed nothing is skipped. */
function changeOf(
  tables: ReadonlyMap<string, Table>,
  logRow: readonly SqlValue[],
): Change | undefined {
  const [tbl, key, op, oldText, newText] = logRow;
  const table = tables.get(String(tbl));
  if (table === undefined) return undefined;
  // SAFETY: the triggers wrote json_object() output; a parse is the column→value object they built
  const parse = (text: SqlValue | undefined): Image =>
    text === null || text === undefined ? {} : (JSON.parse(String(text)) as Image);
  const k = rowKey(String(key));
  if (op === "insert")
    return { kind: "insert", table: table.name, key: k, row: cells(table, parse(newText)) };
  if (op === "delete") return { kind: "delete", table: table.name, key: k };
  const patch = cells(table, parse(newText), parse(oldText));
  return patch.size === 0 ? undefined : { kind: "update", table: table.name, key: k, patch };
}

/**
 * Runs `fn` — the app's own SQL, through any ORM — in one transaction with capture armed, and
 * returns what it changed as kernel changes, in statement order. A throw inside `fn` rolls the
 * whole transaction back and nothing is returned; the log is cleared either way.
 */
export function captureChanges(
  driver: SqliteDriver,
  tables: readonly Table[],
  fn: () => Promise<void>,
): Promise<Result<readonly Change[], StoreFailure>> {
  const byName = new Map(tables.map((t) => [String(t.name), t]));
  return attempt("change capture failed", () =>
    inTransaction(driver, async () => {
      await driver.run(`UPDATE ${GUARD} SET armed = 1 WHERE id = 1`);
      try {
        await fn();
        const logged = await driver.all(
          `SELECT tbl, key, op, old, new FROM ${CHANGES} ORDER BY seq`,
        );
        await driver.run(`DELETE FROM ${CHANGES}`);
        return logged.map((row) => changeOf(byName, row)).filter((c) => c !== undefined);
      } finally {
        await driver.run(`UPDATE ${GUARD} SET armed = 0 WHERE id = 1`);
      }
    }),
  );
}

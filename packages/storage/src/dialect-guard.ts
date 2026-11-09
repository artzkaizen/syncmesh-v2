import type { TableName } from "@syncmesh/kernel";
import type { Table } from "@syncmesh/schema";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@syncmesh/wire";

import type { CaptureSql, StagedSql } from "./dialect.js";

import { literal, quote, tableColumns, type TableColumns } from "./identifiers.js";

/*
 * The strict-capture guard in each dialect (gaps U5): triggers that refuse a write to a synced
 * table made with capture at rest, and the two statements the fold's own writes pass them
 * between. Kept apart from the capture triggers, so the guard is installed and dropped on its own
 * and never changes the tables' fingerprint (`schemaName`).
 *
 * A staged table (RFC-0025) takes such a write instead of refusing it: a trigger files the row's
 * before and after in the staged-changes queue, which `stagedChangeSource` sweeps into events.
 */

type GuardSql = Pick<
  CaptureSql,
  "guardDdl" | "unguardDdl" | "guardedTables" | "fold" | "unfold" | "guardRow" | "staged"
>;

/** A dialect's logged row image: the same encoding the capture triggers write (`CaptureSql`). */
type Image = (columns: TableColumns, alias: string) => string;

/** The SQLite capture guard's one row: `armed` is 0 at rest, 1 capturing, 2 the fold writing. */
export const SQLITE_ROW = "syncmesh_capture";

/** Creates that row where it is missing; part of the capture DDL, and run by a projection's open. */
export const SQLITE_GUARD_ROW = [
  `CREATE TABLE IF NOT EXISTS ${SQLITE_ROW} (id INTEGER PRIMARY KEY, armed INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO ${SQLITE_ROW} (id, armed) VALUES (1, 0)`,
] as const;

/** Capture at rest and no fold writing: a write now is one no event will carry. */
const AT_REST = `COALESCE((SELECT armed FROM ${SQLITE_ROW} WHERE id = 1), 0) = 0`;

const SQLITE_OPS = ["INSERT", "UPDATE", "DELETE"] as const;

/** The staged-changes queue on SQLite: in `main`, because a trigger cannot write an attached file. */
const SQLITE_STAGED = "syncmesh_staged";

// a table name is `[a-z][a-zA-Z0-9_]*`, so the `.` keeps this apart from every capture trigger's
// name, and neither it nor the message needs escaping
const sqliteGuardName = (table: TableName, op: (typeof SQLITE_OPS)[number]) =>
  `"_syncmesh_strict.${table}.${op}"`;

/** The staging triggers: one per operation, and `REKEY` for an update that changes the key. */
const SQLITE_STAGE_TRIGGERS = [...SQLITE_OPS, "REKEY"] as const;

// the same prefix as the refusing triggers, so `guardedTables` finds a staged table too
const sqliteStageName = (table: TableName, trigger: (typeof SQLITE_STAGE_TRIGGERS)[number]) =>
  `"_syncmesh_strict.${table}.stage_${trigger}"`;

const sqliteUnstage = (table: TableName) =>
  SQLITE_STAGE_TRIGGERS.map(
    (trigger) => `DROP TRIGGER IF EXISTS ${sqliteStageName(table, trigger)}`,
  );

const sqliteUnguard = (table: TableName) => [
  ...SQLITE_OPS.map((op) => `DROP TRIGGER IF EXISTS ${sqliteGuardName(table, op)}`),
  ...sqliteUnstage(table),
];

/**
 * The triggers that file a staged table's unarmed writes, dropped first so a changed column list
 * replaces them. An update that changes the key is filed as a delete of the old key and an insert
 * of the new one: as an update it would leave the old row in the mesh and a partial one under the
 * new key.
 */
const sqliteStaging = (table: Table, image: Image): readonly string[] => {
  const pk = table.columnNames[table.primaryKey];
  if (pk === undefined) return [];
  const columns = tableColumns(table);
  const key = (alias: "NEW" | "OLD") => `CAST(${alias}.${quote(pk)} AS TEXT)`;
  const rows = {
    insert: `'insert', ${key("NEW")}, NEW."_partition", NULL, ${image(columns, "NEW")}`,
    update: `'update', ${key("NEW")}, NEW."_partition", ${image(columns, "OLD")}, ${image(columns, "NEW")}`,
    delete: `'delete', ${key("OLD")}, OLD."_partition", ${image(columns, "OLD")}, NULL`,
  };
  const same = `OLD.${quote(pk)} IS NEW.${quote(pk)}`;
  const triggers = {
    INSERT: ["INSERT", AT_REST, [rows.insert]],
    UPDATE: ["UPDATE", `${AT_REST} AND ${same}`, [rows.update]],
    DELETE: ["DELETE", AT_REST, [rows.delete]],
    REKEY: ["UPDATE", `${AT_REST} AND NOT (${same})`, [rows.delete, rows.insert]],
  } as const;
  return SQLITE_STAGE_TRIGGERS.flatMap((trigger) => {
    const [op, when, filed] = triggers[trigger];
    const inserts = filed.map(
      (values) =>
        `INSERT INTO ${SQLITE_STAGED} (tbl, op, key, part, old, new) VALUES (${literal(table.name)}, ${values});`,
    );
    return [
      `DROP TRIGGER IF EXISTS ${sqliteStageName(table.name, trigger)}`,
      `CREATE TRIGGER ${sqliteStageName(table.name, trigger)} AFTER ${op} ON ${quote(table.name)} WHEN ${when} BEGIN ${inserts.join(" ")} END`,
    ];
  });
};

/** The SQLite guard, filing staged tables' writes in the image `image` builds. */
export const sqliteGuard = (image: Image): GuardSql => ({
  guardRow: SQLITE_GUARD_ROW,
  guardedTables: `SELECT DISTINCT tbl_name FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, 17) = '_syncmesh_strict.'`,
  unguardDdl: sqliteUnguard,
  guardDdl: (tables, mode) => [
    ...(tables.some((table) => mode(table) === "stage") ? SQLITE_STAGED_SQL.ddl : []),
    ...tables.flatMap((table) => {
      const chosen = mode(table);
      if (chosen === "off") return sqliteUnguard(table.name);
      if (chosen === "stage") {
        return [
          ...SQLITE_OPS.map((op) => `DROP TRIGGER IF EXISTS ${sqliteGuardName(table.name, op)}`),
          ...sqliteStaging(table, image),
        ];
      }
      return [
        ...sqliteUnstage(table.name),
        ...SQLITE_OPS.map((op) => {
          const name = sqliteGuardName(table.name, op);
          const refusal = `'syncmesh: ${op} on synced table ${table.name} outside a captured write would diverge from the log; write through the mesh, or open the stores with strict: false'`;
          return `CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${op} ON ${quote(table.name)} WHEN ${AT_REST} BEGIN SELECT RAISE(ABORT, ${refusal}); END`;
        }),
      ];
    }),
  ],
  // 2 is the fold's: the guard lets it by and the capture triggers, which fire on 1, log nothing
  fold: `UPDATE ${SQLITE_ROW} SET armed = 2 WHERE id = 1 AND armed = 0`,
  unfold: `UPDATE ${SQLITE_ROW} SET armed = 0 WHERE id = 1 AND armed = 2`,
  staged: SQLITE_STAGED_SQL,
});

const SQLITE_STAGED_SQL: StagedSql = {
  ddl: [
    `CREATE TABLE IF NOT EXISTS ${SQLITE_STAGED} (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, op TEXT NOT NULL, key TEXT NOT NULL, part TEXT, old TEXT, new TEXT, sweep INTEGER)`,
    `CREATE INDEX IF NOT EXISTS ${SQLITE_STAGED}_sweep ON ${SQLITE_STAGED} (sweep, seq)`,
  ],
  forget: `DELETE FROM ${SQLITE_STAGED} WHERE sweep IS NOT NULL AND sweep <= ?`,
  newest: `SELECT MAX(sweep) FROM ${SQLITE_STAGED}`,
  claim: `UPDATE ${SQLITE_STAGED} SET sweep = ? WHERE sweep IS NULL`,
  read: `SELECT tbl, op, key, part, old, new, sweep FROM ${SQLITE_STAGED} WHERE sweep IS NOT NULL AND sweep > ? ORDER BY sweep, seq`,
  depth: `SELECT COUNT(*) FROM ${SQLITE_STAGED}`,
};

/** The capture setting: `'0'` at rest, `'1'` capturing, `'2'` the fold writing; unset reads as `'0'`. */
export const PG_ARMED = `COALESCE(NULLIF(current_setting('syncmesh.armed', true), ''), '0')`;

const GUARD = "syncmesh.capture_guard";

/**
 * Refuses a row write with capture at rest, and a `TRUNCATE` at any time but the fold's: no row
 * trigger sees a truncate, so not even an armed capture could turn one into an event (gaps U5).
 */
const GUARD_FUNCTION = `CREATE OR REPLACE FUNCTION ${GUARD}() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  armed text := ${PG_ARMED};
BEGIN
  IF armed = '2' OR (armed = '1' AND TG_OP <> 'TRUNCATE') THEN
    IF TG_LEVEL = 'STATEMENT' THEN RETURN NULL; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'syncmesh: % on synced table % outside a captured write would diverge from the log', TG_OP, TG_TABLE_NAME
    USING HINT = 'write through the mesh, or open the stores with strict: false';
END $$`;

// a table name is `[a-z][a-zA-Z0-9_]*`, so the `.` keeps these apart from the capture trigger
const PG_ROWS = `"syncmesh.strict"`;
const PG_TRUNCATE = `"syncmesh.strict_truncate"`;
const PG_STAGE = `"syncmesh.stage"`;

/** The staged-changes queue on Postgres, in the `syncmesh` schema beside the log. */
const PG_STAGED = "syncmesh.staged";

/** Postgres cuts an identifier at 63 bytes, which would let two long table names share one function. */
const PG_IDENTIFIER_BYTES = 63;

/**
 * A staged table's filing function: `stage_<table>`, or for a name too long to fit, a prefix of
 * it and a hash of the whole, so every table keeps a function of its own.
 */
export const pgStageFunctionName = (table: TableName) => {
  const plain = `stage_${table}`;
  if (plain.length <= PG_IDENTIFIER_BYTES) return plain;
  const hash = bytesToHex(sha256(new TextEncoder().encode(table))).slice(0, 16);
  return `stage_${table.slice(0, PG_IDENTIFIER_BYTES - "stage_".length - hash.length - 1)}_${hash}`;
};

const pgStageFunction = (table: TableName) => `syncmesh."${pgStageFunctionName(table)}"`;

const pgUnstage = (table: TableName) => [
  `DROP TRIGGER IF EXISTS ${PG_STAGE} ON ${quote(table)}`,
  `DROP FUNCTION IF EXISTS ${pgStageFunction(table)}()`,
];

const pgUnguard = (table: TableName) => [
  `DROP TRIGGER IF EXISTS ${PG_ROWS} ON ${quote(table)}`,
  `DROP TRIGGER IF EXISTS ${PG_TRUNCATE} ON ${quote(table)}`,
  ...pgUnstage(table),
];

/** Refuses a `TRUNCATE` but the fold's, which no row trigger sees: staged or refused, a table keeps it. */
const pgTruncateGuard = (on: string) => [
  `CREATE OR REPLACE TRIGGER ${PG_TRUNCATE} BEFORE TRUNCATE ON ${on} FOR EACH STATEMENT EXECUTE FUNCTION ${GUARD}()`,
  // ALWAYS: `session_replication_role = replica` skips ordinary triggers, not these
  `ALTER TABLE ${on} ENABLE ALWAYS TRIGGER ${PG_TRUNCATE}`,
];

/**
 * The function and trigger that file a staged table's unarmed row writes, an update that changes
 * the key as a delete and an insert. The function runs as the role that installed it, so a service
 * whose role may write only the table still files its writes — it needs no grant on the
 * `syncmesh` schema, its queue or the queue's sequence.
 */
const pgStaging = (table: Table, image: Image): readonly string[] => {
  const pk = table.columnNames[table.primaryKey];
  if (pk === undefined) return [];
  const on = quote(table.name);
  const columns = tableColumns(table);
  const file = (values: string) =>
    `INSERT INTO ${PG_STAGED} (tbl, op, key, part, old, new) VALUES (${literal(table.name)}, ${values});`;
  return [
    `CREATE OR REPLACE FUNCTION ${pgStageFunction(table.name)}() RETURNS trigger LANGUAGE plpgsql
    SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF ${PG_ARMED} = '0' THEN
        IF TG_OP = 'INSERT' THEN
          ${file(`'insert', NEW.${quote(pk)}::text, NEW."_partition", NULL, ${image(columns, "NEW")}`)}
        ELSIF TG_OP = 'UPDATE' AND NEW.${quote(pk)} IS DISTINCT FROM OLD.${quote(pk)} THEN
          ${file(`'delete', OLD.${quote(pk)}::text, OLD."_partition", ${image(columns, "OLD")}, NULL`)}
          ${file(`'insert', NEW.${quote(pk)}::text, NEW."_partition", NULL, ${image(columns, "NEW")}`)}
        ELSIF TG_OP = 'UPDATE' THEN
          ${file(`'update', NEW.${quote(pk)}::text, NEW."_partition", ${image(columns, "OLD")}, ${image(columns, "NEW")}`)}
        ELSE
          ${file(`'delete', OLD.${quote(pk)}::text, OLD."_partition", ${image(columns, "OLD")}, NULL`)}
        END IF;
      END IF;
      RETURN NULL;
    END $$`,
    // a trigger fires its function whatever the writer may run, so nobody needs to call it
    `REVOKE EXECUTE ON FUNCTION ${pgStageFunction(table.name)}() FROM PUBLIC`,
    `CREATE OR REPLACE TRIGGER ${PG_STAGE} AFTER INSERT OR UPDATE OR DELETE ON ${on} FOR EACH ROW EXECUTE FUNCTION ${pgStageFunction(table.name)}()`,
    `ALTER TABLE ${on} ENABLE ALWAYS TRIGGER ${PG_STAGE}`,
  ];
};

const POSTGRES_STAGED_SQL: StagedSql = {
  ddl: [
    `CREATE TABLE IF NOT EXISTS ${PG_STAGED} (seq BIGSERIAL PRIMARY KEY, tbl TEXT NOT NULL, op TEXT NOT NULL, key TEXT NOT NULL, part TEXT, old TEXT, new TEXT, sweep BIGINT)`,
    `CREATE INDEX IF NOT EXISTS staged_sweep ON ${PG_STAGED} (sweep, seq)`,
  ],
  forget: `DELETE FROM ${PG_STAGED} WHERE sweep IS NOT NULL AND sweep <= $1`,
  newest: `SELECT MAX(sweep) FROM ${PG_STAGED}`,
  claim: `UPDATE ${PG_STAGED} SET sweep = $1 WHERE sweep IS NULL`,
  read: `SELECT tbl, op, key, part, old, new, sweep FROM ${PG_STAGED} WHERE sweep IS NOT NULL AND sweep > $1 ORDER BY sweep, seq`,
  depth: `SELECT COUNT(*) FROM ${PG_STAGED}`,
};

/** The Postgres guard, filing staged tables' writes in the image `image` builds. */
export const postgresGuard = (image: Image): GuardSql => ({
  // a transaction-local setting needs nothing created
  guardRow: [],
  // only tables an unqualified name reaches: the ones this database's synced tables resolve to
  guardedTables: `SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname IN ('syncmesh.strict', 'syncmesh.strict_truncate', 'syncmesh.stage') AND pg_table_is_visible(c.oid)`,
  unguardDdl: pgUnguard,
  guardDdl: (tables, mode) => [
    GUARD_FUNCTION,
    ...(tables.some((table) => mode(table) === "stage") ? POSTGRES_STAGED_SQL.ddl : []),
    ...tables.flatMap((table) => {
      const on = quote(table.name);
      const chosen = mode(table);
      if (chosen === "off") return pgUnguard(table.name);
      if (chosen === "stage") {
        return [
          `DROP TRIGGER IF EXISTS ${PG_ROWS} ON ${on}`,
          ...pgTruncateGuard(on),
          ...pgStaging(table, image),
        ];
      }
      return [
        ...pgUnstage(table.name),
        `CREATE OR REPLACE TRIGGER ${PG_ROWS} BEFORE INSERT OR UPDATE OR DELETE ON ${on} FOR EACH ROW EXECUTE FUNCTION ${GUARD}()`,
        ...pgTruncateGuard(on),
        `ALTER TABLE ${on} ENABLE ALWAYS TRIGGER ${PG_ROWS}`,
      ];
    }),
  ],
  // '2' is the fold's: the guard lets it by and the capture function, which logs on '1', does not
  fold: `SELECT set_config('syncmesh.armed', CASE WHEN ${PG_ARMED} = '1' THEN '1' ELSE '2' END, true)`,
  unfold: `SELECT set_config('syncmesh.armed', CASE WHEN ${PG_ARMED} = '2' THEN '0' ELSE ${PG_ARMED} END, true)`,
  staged: POSTGRES_STAGED_SQL,
});

import type { TableName } from "@syncmesh/kernel";

import type { CaptureSql } from "./dialect.js";

import { quote } from "./identifiers.js";

/*
 * The strict-capture guard in each dialect (gaps U5): triggers that refuse a write to a synced
 * table made with capture at rest, and the two statements the fold's own writes pass them
 * between. Kept apart from the capture triggers, so the guard is installed and dropped on its own
 * and never changes the tables' fingerprint (`schemaName`).
 */

type GuardSql = Pick<
  CaptureSql,
  "guardDdl" | "unguardDdl" | "guardedTables" | "fold" | "unfold" | "guardRow"
>;

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

// a table name is `[a-z][a-zA-Z0-9_]*`, so the `.` keeps this apart from every capture trigger's
// name, and neither it nor the message needs escaping
const sqliteGuardName = (table: TableName, op: (typeof SQLITE_OPS)[number]) =>
  `"_syncmesh_strict.${table}.${op}"`;

export const SQLITE_GUARD: GuardSql = {
  guardRow: SQLITE_GUARD_ROW,
  guardedTables: `SELECT DISTINCT tbl_name FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, 17) = '_syncmesh_strict.'`,
  unguardDdl: (table) =>
    SQLITE_OPS.map((op) => `DROP TRIGGER IF EXISTS ${sqliteGuardName(table, op)}`),
  guardDdl: (tables, guarded) =>
    tables.flatMap((table) =>
      SQLITE_OPS.map((op) => {
        const name = sqliteGuardName(table.name, op);
        if (!guarded(table)) return `DROP TRIGGER IF EXISTS ${name}`;
        const refusal = `'syncmesh: ${op} on synced table ${table.name} outside a captured write would diverge from the log; write through the mesh, or open the stores with strict: false'`;
        return `CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${op} ON ${quote(table.name)} WHEN ${AT_REST} BEGIN SELECT RAISE(ABORT, ${refusal}); END`;
      }),
    ),
  // 2 is the fold's: the guard lets it by and the capture triggers, which fire on 1, log nothing
  fold: `UPDATE ${SQLITE_ROW} SET armed = 2 WHERE id = 1 AND armed = 0`,
  unfold: `UPDATE ${SQLITE_ROW} SET armed = 0 WHERE id = 1 AND armed = 2`,
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

const pgUnguard = (table: TableName) => [
  `DROP TRIGGER IF EXISTS ${PG_ROWS} ON ${quote(table)}`,
  `DROP TRIGGER IF EXISTS ${PG_TRUNCATE} ON ${quote(table)}`,
];

export const POSTGRES_GUARD: GuardSql = {
  // a transaction-local setting needs nothing created
  guardRow: [],
  // only tables an unqualified name reaches: the ones this database's synced tables resolve to
  guardedTables: `SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname IN ('syncmesh.strict', 'syncmesh.strict_truncate') AND pg_table_is_visible(c.oid)`,
  unguardDdl: pgUnguard,
  guardDdl: (tables, guarded) => [
    GUARD_FUNCTION,
    ...tables.flatMap((table) => {
      const on = quote(table.name);
      if (!guarded(table)) return pgUnguard(table.name);
      return [
        `CREATE OR REPLACE TRIGGER ${PG_ROWS} BEFORE INSERT OR UPDATE OR DELETE ON ${on} FOR EACH ROW EXECUTE FUNCTION ${GUARD}()`,
        `CREATE OR REPLACE TRIGGER ${PG_TRUNCATE} BEFORE TRUNCATE ON ${on} FOR EACH STATEMENT EXECUTE FUNCTION ${GUARD}()`,
        // ALWAYS: `session_replication_role = replica` skips ordinary triggers, not these
        `ALTER TABLE ${on} ENABLE ALWAYS TRIGGER ${PG_ROWS}`,
        `ALTER TABLE ${on} ENABLE ALWAYS TRIGGER ${PG_TRUNCATE}`,
      ];
    }),
  ],
  // '2' is the fold's: the guard lets it by and the capture function, which logs on '1', does not
  fold: `SELECT set_config('syncmesh.armed', CASE WHEN ${PG_ARMED} = '1' THEN '1' ELSE '2' END, true)`,
  unfold: `SELECT set_config('syncmesh.armed', CASE WHEN ${PG_ARMED} = '2' THEN '0' ELSE ${PG_ARMED} END, true)`,
};

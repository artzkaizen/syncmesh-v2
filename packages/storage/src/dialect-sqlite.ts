import type { CellValue } from "@syncmesh/kernel";
import type { ColumnKind, Table } from "@syncmesh/schema";

import type { CaptureSql, Dialect } from "./dialect.js";
import type { SqlValue } from "./driver.js";

import { SQLITE_OPERATIONS } from "./dialect-operations.js";
import { columnsOf, literal, quote } from "./identifiers.js";

const CHANGES = "syncmesh_changes";
const GUARD = "syncmesh_capture";

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

/** Triggers fire only while a guard row is armed, so the fold's own UPSERTs are never re-captured. */
const capture: CaptureSql = {
  tableDdl: (table) => {
    const columns = columnsOf(table).map(([key, name, column]) => {
      const constraint = key === table.primaryKey ? " PRIMARY KEY" : "";
      return `${quote(name)} ${sqlType(column.def.kind)}${constraint}`;
    });
    return `CREATE TABLE IF NOT EXISTS ${quote(table.name)} (${[...columns, '"_partition" TEXT'].join(", ")})`;
  },
  captureDdl: (tables) => {
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
  },
  arm: `UPDATE ${GUARD} SET armed = 1 WHERE id = 1`,
  disarm: `UPDATE ${GUARD} SET armed = 0 WHERE id = 1`,
  selectLog: `SELECT tbl, key, op, old, new FROM ${CHANGES} ORDER BY seq`,
  clearLog: `DELETE FROM ${CHANGES}`,
  stampPartition: (table, pk, partitionColumn) =>
    `UPDATE ${quote(table)} SET "${partitionColumn.replaceAll('"', '""')}" = ? WHERE ${quote(pk)} = ?`,
};

const SQLITE_COMPACTABLE = `FROM syncmesh_events
  WHERE local = ? AND hlc_ms < ?
    AND seq <= COALESCE((SELECT value FROM json_each(?) WHERE key = syncmesh_events.peer), 0)`;

const SQLITE_MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE IF NOT EXISTS events (
      peer TEXT NOT NULL,
      seq INTEGER NOT NULL,
      local INTEGER NOT NULL,
      hlc_ms INTEGER NOT NULL,
      hlc_logical INTEGER NOT NULL,
      partition TEXT,
      core BLOB NOT NULL,
      PRIMARY KEY (peer, seq, local)
    ) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS events_hlc ON events (hlc_ms, hlc_logical)`,
    `CREATE TABLE IF NOT EXISTS state_rows (
      tbl TEXT NOT NULL,
      key TEXT NOT NULL,
      record BLOB NOT NULL,
      PRIMARY KEY (tbl, key)
    ) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS state_cursors (
      peer TEXT NOT NULL,
      local INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (peer, local)
    ) WITHOUT ROWID`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS compaction (
      peer TEXT NOT NULL,
      local INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      hlc_ms INTEGER NOT NULL,
      hlc_logical INTEGER NOT NULL,
      PRIMARY KEY (peer, local)
    ) WITHOUT ROWID`,
  ],
  [`ALTER TABLE events ADD COLUMN sig BLOB`],
  [
    // one row, or none: the interest this device's cursors are true for (D23). A database that
    // has never held one is unscoped, which is the plain, stronger meaning of a cursor
    `CREATE TABLE IF NOT EXISTS state_scope (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      scope TEXT NOT NULL
    ) WITHOUT ROWID`,
  ],
  /**
   * The namespace, arrived at late (RFC-0022). Seven tables shipped with bare names — `events`,
   * `operations`, `compaction` — in the one file an app also keeps its own tables in, so an app
   * with an `events` table of its own collided with the engine and learned about it through a
   * DDL error. They are `syncmesh_` now, which is the only namespace SQLite has, and the same
   * word Postgres spells as a real `CREATE SCHEMA syncmesh`.
   *
   * **A step rather than a change to the four above**, which is why those still create the old
   * names for a moment. A database at `user_version = 4` holds tables under the names those
   * steps wrote, and renaming in place is the only thing that can move *it*; rewriting the
   * earlier steps would strand every device that already ran them. A fresh database pays four
   * creates and six renames once, at its first open, and is then indistinguishable.
   */
  [
    `ALTER TABLE events RENAME TO syncmesh_events`,
    `ALTER TABLE state_rows RENAME TO syncmesh_state_rows`,
    `ALTER TABLE state_cursors RENAME TO syncmesh_cursors`,
    `ALTER TABLE state_scope RENAME TO syncmesh_scope`,
    `ALTER TABLE compaction RENAME TO syncmesh_compaction`,
    // SQLite has no `ALTER INDEX`: a renamed table keeps its indexes, under their old names, so
    // the index is dropped and rebuilt. It is the one statement here that costs a scan
    `DROP INDEX IF EXISTS events_hlc`,
    `CREATE INDEX IF NOT EXISTS syncmesh_events_hlc ON syncmesh_events (hlc_ms, hlc_logical)`,
  ],
];

const sqliteCell = (kind: ColumnKind, cell: CellValue): SqlValue => {
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

export const SQLITE: Dialect = {
  name: "sqlite",
  events: {
    insert: `INSERT OR IGNORE INTO syncmesh_events
      (peer, seq, local, hlc_ms, hlc_logical, partition, core, sig)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    selectAll: `SELECT core, local, sig FROM syncmesh_events ORDER BY hlc_ms, hlc_logical, peer, seq`,
    selectRecent: `SELECT peer, seq, local, hlc_ms, hlc_logical, partition, length(core) FROM syncmesh_events
      WHERE hlc_ms < ?1 OR (hlc_ms = ?1 AND hlc_logical < ?2)
      ORDER BY hlc_ms DESC, hlc_logical DESC LIMIT ?3`,
    selectSince: `SELECT core, local, sig FROM syncmesh_events
      WHERE local = ?
        AND seq > COALESCE((SELECT value FROM json_each(?) WHERE key = syncmesh_events.peer), 0)
      ORDER BY peer, seq`,
    selectStranded: `SELECT core, local, sig FROM syncmesh_events
      WHERE sig IS NULL AND local = 0 AND peer <> ? ORDER BY peer, seq`,
    selectHas: `SELECT 1 FROM syncmesh_events WHERE peer = ? AND seq = ? AND local = ? LIMIT 1`,
    selectLastSeq: `SELECT MAX(seq) FROM (
      SELECT seq FROM syncmesh_events WHERE peer = ?1 AND local = ?2
      UNION ALL SELECT seq FROM syncmesh_compaction WHERE peer = ?1 AND local = ?2)`,
    selectCompactable: `SELECT peer, MAX(seq), COUNT(*) ${SQLITE_COMPACTABLE} GROUP BY peer`,
    selectCompactableStamp: `SELECT hlc_ms, hlc_logical ${SQLITE_COMPACTABLE} AND peer = ?
      ORDER BY hlc_ms DESC, hlc_logical DESC LIMIT 1`,
    deleteCompactable: `DELETE ${SQLITE_COMPACTABLE}`,
    upsertFloor: `INSERT INTO syncmesh_compaction (peer, local, seq, hlc_ms, hlc_logical)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (peer, local) DO UPDATE SET
        seq = MAX(seq, excluded.seq),
        hlc_logical = CASE
          WHEN excluded.hlc_ms > hlc_ms THEN excluded.hlc_logical
          WHEN excluded.hlc_ms = hlc_ms THEN MAX(hlc_logical, excluded.hlc_logical)
          ELSE hlc_logical END,
        hlc_ms = MAX(hlc_ms, excluded.hlc_ms)`,
    selectFloors: `SELECT peer, local, seq FROM syncmesh_compaction`,
    selectMaxHlc: `SELECT hlc_ms, hlc_logical FROM (
      SELECT hlc_ms, hlc_logical FROM syncmesh_events UNION ALL SELECT hlc_ms, hlc_logical FROM syncmesh_compaction)
      ORDER BY hlc_ms DESC, hlc_logical DESC LIMIT 1`,
  },
  state: {
    upsertRow: `INSERT OR REPLACE INTO syncmesh_state_rows (tbl, key, record) VALUES (?, ?, ?)`,
    upsertCursor: `INSERT OR REPLACE INTO syncmesh_cursors (peer, local, seq) VALUES (?, ?, ?)`,
    selectRows: `SELECT tbl, key, record FROM syncmesh_state_rows`,
    selectCursors: `SELECT peer, local, seq FROM syncmesh_cursors`,
    anyCursor: `SELECT 1 FROM syncmesh_cursors LIMIT 1`,
    clearRows: `DELETE FROM syncmesh_state_rows`,
    clearCursors: `DELETE FROM syncmesh_cursors`,
    selectScope: `SELECT scope FROM syncmesh_scope`,
    upsertScope: `INSERT OR REPLACE INTO syncmesh_scope (id, scope) VALUES (0, ?)`,
    clearScope: `DELETE FROM syncmesh_scope`,
  },
  capture,
  operations: SQLITE_OPERATIONS,
  placeholder: () => "?",
  cell: sqliteCell,
  schema: {
    ddl: `CREATE TABLE IF NOT EXISTS syncmesh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    read: `SELECT value FROM syncmesh_meta WHERE key = 'schema'`,
    write: `INSERT OR REPLACE INTO syncmesh_meta (key, value) VALUES ('schema', ?)`,
  },
  migrate: async (driver) => {
    const [row] = await driver.all("PRAGMA user_version");
    const applied = Number(row?.[0] ?? 0);
    // nothing to apply is nothing to write: a launch that migrated nothing should touch no page,
    // and this runs twice per open — once for the event store and once for the state store
    if (applied >= SQLITE_MIGRATIONS.length) return;
    for (const step of SQLITE_MIGRATIONS.slice(applied))
      for (const sql of step) await driver.run(sql);
    await driver.run(`PRAGMA user_version = ${SQLITE_MIGRATIONS.length}`);
  },
};

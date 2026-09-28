import type { CellValue } from "@syncmesh/kernel";
import type { ColumnKind, Table } from "@syncmesh/schema";

import type { CaptureSql, Dialect } from "./dialect.js";
import type { LogPlacement, SqlValue } from "./driver.js";
import type { Rung } from "./ladder.js";

import { SQLITE_DOCS, SQLITE_DOC_TABLES } from "./dialect-docs.js";
import { sqliteOperations } from "./dialect-operations.js";
import { columnsOf, literal, quote } from "./identifiers.js";
import { ladder } from "./ladder.js";
import { logTable, sqliteLogIndex } from "./namespace.js";

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

/**
 * The position as a `user_version`, which is a property of the file and persists with it — so the
 * log's ladder and the derived half's are each versioned by the database they live in.
 */
const userVersion = (schema: string): Rung => ({
  read: async (driver) => Number((await driver.all(`PRAGMA ${schema}.user_version`))[0]?.[0] ?? 0),
  write: (driver, step) => driver.run(`PRAGMA ${schema}.user_version = ${step}`),
});


/**
 * The position as a row, for a runtime whose SQL surface has no `PRAGMA` at all.
 *
 * A Durable Object is the case (RFC-0022): one database, no `ATTACH`, and `PRAGMA` refused — so
 * the mechanism the other two spellings version themselves by is simply not reachable. `meta` is
 * where the app-schema fingerprint already lives and this is the same kind of fact, which is why
 * it is a second key rather than a second table. Postgres versions itself the same way, for the
 * same reason in a different form: a schema has no `user_version` either.
 */
const metaRow = (table: string, key: string): Rung => ({
  read: async (driver) => {
    await driver.run(
      `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    const [row] = await driver.all(`SELECT value FROM ${table} WHERE key = ?`, [key]);
    return Number(row?.[0] ?? 0);
  },
  write: (driver, step) =>
    driver.run(`INSERT OR REPLACE INTO ${table} (key, value) VALUES (?, ?)`, [key, String(step)]),
});

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

/**
 * Everything whose spelling depends on where the log lives.
 *
 * Two instances rather than two files of near-identical SQL: the difference between a device and
 * a Durable Object is one separator — `syncmesh.events` against `syncmesh_events` — plus the two
 * index statements, which differ in shape rather than in name. Writing it twice would be writing
 * the same forty statements twice and finding out which copy drifted at a migration on one
 * runtime only.
 */
const sqliteDialect = (log: LogPlacement): Dialect => {
  const t = (name: string) => logTable(name, log);
  const indexDdl = sqliteLogIndex(log);
  const rungs =
    log === "inline"
      ? { log: metaRow(t("meta"), "log_version"), state: metaRow(t("meta"), "state_version") }
      : { log: userVersion("syncmesh"), state: userVersion("main") };

  const compactable = `FROM ${t("events")}
    WHERE local = ? AND hlc_ms < ?
      AND seq <= COALESCE((SELECT value FROM json_each(?) WHERE key = ${t("events")}.peer), 0)`;

  /**
   * The durable half's schema, in the attached database, on its own ladder.
   *
   * **Two files, two `user_version`s** — `PRAGMA syncmesh.user_version` is a property of the
   * attached database and persists with it, so each half is versioned by the file it lives in
   * rather than by a counter in the other one. That is what makes the split tractable: the log's
   * shape changes for log reasons and the projection's for schema reasons, and neither has to know
   * when the other moved.
   *
   * One step, because this is the shape the log has now. History is not preserved here on purpose:
   * nothing has shipped, and a ladder whose earlier rungs nobody has ever stood on is a museum.
   */
  const logSteps: readonly (readonly string[])[] = [
    [
      `CREATE TABLE IF NOT EXISTS ${t("events")} (
        peer TEXT NOT NULL,
        seq INTEGER NOT NULL,
        local INTEGER NOT NULL,
        hlc_ms INTEGER NOT NULL,
        hlc_logical INTEGER NOT NULL,
        partition TEXT,
        core BLOB NOT NULL,
        sig BLOB,
        PRIMARY KEY (peer, seq, local)
      ) WITHOUT ROWID`,
      indexDdl("events_hlc", "events", "(hlc_ms, hlc_logical)"),
      `CREATE TABLE IF NOT EXISTS ${t("compaction")} (
        peer TEXT NOT NULL,
        local INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        hlc_ms INTEGER NOT NULL,
        hlc_logical INTEGER NOT NULL,
        PRIMARY KEY (peer, local)
      ) WITHOUT ROWID`,
      // one row, or none: the interest this device's cursors are true for (D23). Durable, because
      // a peer gave it and no replay of this device's own log can recover it
      `CREATE TABLE IF NOT EXISTS ${t("scope")} (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        scope TEXT NOT NULL
      ) WITHOUT ROWID`,
    ],
  ];

  /** The derived half's, in `main`, beside the app's own tables. Rebuilt by folding the log. */
  const stateSteps: readonly (readonly string[])[] = [
    [
      `CREATE TABLE IF NOT EXISTS syncmesh_state_rows (
        tbl TEXT NOT NULL,
        key TEXT NOT NULL,
        record BLOB NOT NULL,
        PRIMARY KEY (tbl, key)
      ) WITHOUT ROWID`,
      `CREATE TABLE IF NOT EXISTS syncmesh_cursors (
        peer TEXT NOT NULL,
        local INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (peer, local)
      ) WITHOUT ROWID`,
    ],
    // The doc log and heads (RFC-0023 §6.2): one step, after the state tables.
    SQLITE_DOC_TABLES,
  ];

  return {
    name: "sqlite",
    events: {
      insert: `INSERT OR IGNORE INTO ${t("events")}
        (peer, seq, local, hlc_ms, hlc_logical, partition, core, sig)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      selectAll: `SELECT core, local, sig FROM ${t("events")} ORDER BY hlc_ms, hlc_logical, peer, seq`,
      selectRecent: `SELECT peer, seq, local, hlc_ms, hlc_logical, partition, length(core) FROM ${t("events")}
        WHERE hlc_ms < ?1 OR (hlc_ms = ?1 AND hlc_logical < ?2)
        ORDER BY hlc_ms DESC, hlc_logical DESC LIMIT ?3`,
      selectSince: `SELECT core, local, sig FROM ${t("events")}
        WHERE local = ?
          AND seq > COALESCE((SELECT value FROM json_each(?) WHERE key = ${t("events")}.peer), 0)
        ORDER BY peer, seq`,
      selectStranded: `SELECT core, local, sig FROM ${t("events")}
        WHERE sig IS NULL AND local = 0 AND peer <> ? ORDER BY peer, seq`,
      selectHas: `SELECT 1 FROM ${t("events")} WHERE peer = ? AND seq = ? AND local = ? LIMIT 1`,
      selectLastSeq: `SELECT MAX(seq) FROM (
        SELECT seq FROM ${t("events")} WHERE peer = ?1 AND local = ?2
        UNION ALL SELECT seq FROM ${t("compaction")} WHERE peer = ?1 AND local = ?2)`,
      selectCompactable: `SELECT peer, MAX(seq), COUNT(*) ${compactable} GROUP BY peer`,
      selectCompactableStamp: `SELECT hlc_ms, hlc_logical ${compactable} AND peer = ?
        ORDER BY hlc_ms DESC, hlc_logical DESC LIMIT 1`,
      deleteCompactable: `DELETE ${compactable}`,
      upsertFloor: `INSERT INTO ${t("compaction")} (peer, local, seq, hlc_ms, hlc_logical)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (peer, local) DO UPDATE SET
          seq = MAX(seq, excluded.seq),
          hlc_logical = CASE
            WHEN excluded.hlc_ms > hlc_ms THEN excluded.hlc_logical
            WHEN excluded.hlc_ms = hlc_ms THEN MAX(hlc_logical, excluded.hlc_logical)
            ELSE hlc_logical END,
          hlc_ms = MAX(hlc_ms, excluded.hlc_ms)`,
      selectFloors: `SELECT peer, local, seq FROM ${t("compaction")}`,
      selectMaxHlc: `SELECT hlc_ms, hlc_logical FROM (
        SELECT hlc_ms, hlc_logical FROM ${t("events")} UNION ALL SELECT hlc_ms, hlc_logical FROM ${t("compaction")})
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
      selectScope: `SELECT scope FROM ${t("scope")}`,
      upsertScope: `INSERT OR REPLACE INTO ${t("scope")} (id, scope) VALUES (0, ?)`,
      clearScope: `DELETE FROM ${t("scope")}`,
    },
    docs: SQLITE_DOCS,
    capture,
    operations: sqliteOperations(log),
    placeholder: () => "?",
    cell: sqliteCell,
    schema: {
      ddl: `CREATE TABLE IF NOT EXISTS ${t("meta")} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      read: `SELECT value FROM ${t("meta")} WHERE key = 'schema'`,
      write: `INSERT OR REPLACE INTO ${t("meta")} (key, value) VALUES ('schema', ?)`,
    },
    migrate: async (driver) => {
      await ladder(driver, rungs.log, logSteps);
      await ladder(driver, rungs.state, stateSteps);
    },
  };
};

/** The two files a device gets: the log attached as `syncmesh`, the derived half as `main`. */
export const SQLITE: Dialect = sqliteDialect("attached");

/**
 * One database, for a runtime with no `ATTACH` to give it two — a Durable Object (RFC-0022).
 *
 * Every table is here, `syncmesh_events` beside `syncmesh_state_rows`, and the line between the
 * durable half and the derived one is still the line: `LOG_TABLES` and `STATE_TABLES` say which
 * is which, and neither of those was ever a question about files.
 */
export const SQLITE_INLINE: Dialect = sqliteDialect("inline");

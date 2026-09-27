import type { CellValue } from "@syncmesh/kernel";
import type { ColumnKind, Table } from "@syncmesh/schema";

import type { CaptureSql, Dialect } from "./dialect.js";
import type { SqlValue } from "./driver.js";

import { POSTGRES_DOCS, POSTGRES_DOC_TABLES } from "./dialect-docs.js";
import { columnsOf, literal, quote } from "./identifiers.js";

const CHANGES = "_syncmesh_changes";

/** What a Drizzle `pg-core` column of the kind would be, so a mesh-created table reads like the app's own. */
const sqlType = (kind: ColumnKind): string => {
  switch (kind) {
    case "integer":
      return "BIGINT";
    case "float":
      return "DOUBLE PRECISION";
    case "boolean":
      return "BOOLEAN";
    case "timestamp":
      return "TIMESTAMPTZ";
    case "json":
      return "JSONB";
    case "blob":
      return "BYTEA";
    default:
      return "TEXT";
  }
};

/** The logged image in the shared shape: hex bytes, epoch-millisecond timestamps, JSON as text. */
const image = (table: Table, alias: "NEW" | "OLD"): string =>
  `json_build_object(${columnsOf(table)
    .map(([, name, column]) => {
      const cell = `${alias}.${quote(name)}`;
      const logged =
        column.def.kind === "blob"
          ? `encode(${cell}, 'hex')`
          : column.def.kind === "timestamp"
            ? `(EXTRACT(EPOCH FROM ${cell}) * 1000)::bigint`
            : column.def.kind === "json"
              ? `${cell}::text`
              : cell;
      return `'${String(name)}', ${logged}`;
    })
    .join(", ")})::text`;

/** A transaction-local setting is the guard: `SET LOCAL` dies with the transaction and locks no row across the pool. */
const ARMED = `COALESCE(NULLIF(current_setting('syncmesh.armed', true), ''), '0') = '1'`;

const capture: CaptureSql = {
  tableDdl: (table) => {
    const columns = columnsOf(table).map(([key, name, column]) => {
      const constraint = key === table.primaryKey ? " PRIMARY KEY" : "";
      return `${quote(name)} ${sqlType(column.def.kind)}${constraint}`;
    });
    return `CREATE TABLE IF NOT EXISTS ${quote(table.name)} (${[...columns, '"_partition" TEXT'].join(", ")})`;
  },
  captureDdl: (tables) => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS ${CHANGES} (seq BIGSERIAL PRIMARY KEY, tbl TEXT NOT NULL, key TEXT NOT NULL, op TEXT NOT NULL, old TEXT, new TEXT)`,
    ];
    for (const table of tables) {
      const name = literal(table.name);
      const pk = table.columnNames[table.primaryKey];
      if (pk === undefined) continue;
      const fn = `"_syncmesh_capture_${String(table.name)}"`;
      const log = (values: string) =>
        `INSERT INTO ${CHANGES} (tbl, key, op, old, new) VALUES (${name}, ${values});`;
      statements.push(
        `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF ${ARMED} THEN
            IF TG_OP = 'INSERT' THEN
              ${log(`NEW.${quote(pk)}::text, 'insert', NULL, ${image(table, "NEW")}`)}
            ELSIF TG_OP = 'UPDATE' THEN
              ${log(`NEW.${quote(pk)}::text, 'update', ${image(table, "OLD")}, ${image(table, "NEW")}`)}
            ELSE
              ${log(`OLD.${quote(pk)}::text, 'delete', ${image(table, "OLD")}, NULL`)}
            END IF;
          END IF;
          RETURN NULL;
        END $$`,
        `CREATE OR REPLACE TRIGGER "_syncmesh_${String(table.name)}" AFTER INSERT OR UPDATE OR DELETE ON ${quote(table.name)} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
      );
    }
    return statements;
  },
  arm: `SET LOCAL syncmesh.armed = '1'`,
  disarm: `SET LOCAL syncmesh.armed = '0'`,
  selectLog: `SELECT tbl, key, op, old, new FROM ${CHANGES} ORDER BY seq`,
  clearLog: `DELETE FROM ${CHANGES}`,
  stampPartition: (table, pk, partitionColumn) =>
    `UPDATE ${quote(table)} SET "${partitionColumn.replaceAll('"', '""')}" = $1 WHERE ${quote(pk)} = $2`,
};

/** The floor a cursor map sets for this author, from the JSON the caller binds. */
const PG_FLOOR = `COALESCE((SELECT f.value::bigint FROM jsonb_each_text($3::jsonb) AS f WHERE f.key = e.peer), 0)`;
const PG_COMPACTABLE = `FROM _syncmesh_events e
  WHERE e.local = $1 AND e.hlc_ms < $2 AND e.seq <= ${PG_FLOOR}`;

const POSTGRES_MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE IF NOT EXISTS _syncmesh_events (
      peer TEXT NOT NULL,
      seq BIGINT NOT NULL,
      local INTEGER NOT NULL,
      hlc_ms BIGINT NOT NULL,
      hlc_logical INTEGER NOT NULL,
      partition TEXT,
      core BYTEA NOT NULL,
      sig BYTEA,
      PRIMARY KEY (peer, seq, local)
    )`,
    `CREATE INDEX IF NOT EXISTS _syncmesh_events_hlc ON _syncmesh_events (hlc_ms, hlc_logical)`,
    `CREATE TABLE IF NOT EXISTS _syncmesh_state (
      tbl TEXT NOT NULL,
      key TEXT NOT NULL,
      record BYTEA NOT NULL,
      PRIMARY KEY (tbl, key)
    )`,
    `CREATE TABLE IF NOT EXISTS _syncmesh_cursors (
      peer TEXT NOT NULL,
      local INTEGER NOT NULL,
      seq BIGINT NOT NULL,
      PRIMARY KEY (peer, local)
    )`,
    `CREATE TABLE IF NOT EXISTS _syncmesh_compaction (
      peer TEXT NOT NULL,
      local INTEGER NOT NULL,
      seq BIGINT NOT NULL,
      hlc_ms BIGINT NOT NULL,
      hlc_logical INTEGER NOT NULL,
      PRIMARY KEY (peer, local)
    )`,
  ],
  [
    // one row, or none: the interest this device's cursors are true for (D23). A database that
    // has never held one is unscoped, which is the plain, stronger meaning of a cursor
    `CREATE TABLE IF NOT EXISTS _syncmesh_scope (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      scope TEXT NOT NULL
    )`,
  ],
  POSTGRES_DOC_TABLES,
];

const postgresCell = (kind: ColumnKind, cell: CellValue): SqlValue => {
  if (cell === null) return null;
  if (cell instanceof Uint8Array) return cell;
  switch (kind) {
    case "boolean":
      return cell === true;
    case "json":
      return JSON.stringify(cell);
    case "timestamp":
      return new Date(Number(cell));
    case "integer":
    case "float":
      return Number(cell);
    default:
      // SAFETY: a text or uuid cell passed the column's kind check when it was written, so it is a string
      return cell as string;
  }
};

export const POSTGRES: Dialect = {
  name: "postgres",
  events: {
    insert: `INSERT INTO _syncmesh_events
      (peer, seq, local, hlc_ms, hlc_logical, partition, core, sig)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (peer, seq, local) DO NOTHING`,
    selectAll: `SELECT core, local, sig FROM _syncmesh_events ORDER BY hlc_ms, hlc_logical, peer, seq`,
    selectSince: `SELECT e.core, e.local, e.sig FROM _syncmesh_events e
      WHERE e.local = $1
        AND e.seq > COALESCE((SELECT f.value::bigint FROM jsonb_each_text($2::jsonb) AS f WHERE f.key = e.peer), 0)
      ORDER BY e.peer, e.seq`,
    selectHas: `SELECT 1 FROM _syncmesh_events WHERE peer = $1 AND seq = $2 AND local = $3 LIMIT 1`,
    selectLastSeq: `SELECT MAX(seq) FROM (
      SELECT seq FROM _syncmesh_events WHERE peer = $1 AND local = $2
      UNION ALL SELECT seq FROM _syncmesh_compaction WHERE peer = $1 AND local = $2) AS u`,
    selectCompactable: `SELECT e.peer, MAX(e.seq), COUNT(*) ${PG_COMPACTABLE} GROUP BY e.peer`,
    selectCompactableStamp: `SELECT e.hlc_ms, e.hlc_logical ${PG_COMPACTABLE} AND e.peer = $4
      ORDER BY e.hlc_ms DESC, e.hlc_logical DESC LIMIT 1`,
    deleteCompactable: `DELETE ${PG_COMPACTABLE}`,
    upsertFloor: `INSERT INTO _syncmesh_compaction (peer, local, seq, hlc_ms, hlc_logical)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (peer, local) DO UPDATE SET
        seq = GREATEST(_syncmesh_compaction.seq, excluded.seq),
        hlc_logical = CASE
          WHEN excluded.hlc_ms > _syncmesh_compaction.hlc_ms THEN excluded.hlc_logical
          WHEN excluded.hlc_ms = _syncmesh_compaction.hlc_ms
            THEN GREATEST(_syncmesh_compaction.hlc_logical, excluded.hlc_logical)
          ELSE _syncmesh_compaction.hlc_logical END,
        hlc_ms = GREATEST(_syncmesh_compaction.hlc_ms, excluded.hlc_ms)`,
    selectFloors: `SELECT peer, local, seq FROM _syncmesh_compaction`,
    selectMaxHlc: `SELECT hlc_ms, hlc_logical FROM (
      SELECT hlc_ms, hlc_logical FROM _syncmesh_events
      UNION ALL SELECT hlc_ms, hlc_logical FROM _syncmesh_compaction) AS u
      ORDER BY hlc_ms DESC, hlc_logical DESC LIMIT 1`,
  },
  state: {
    upsertRow: `INSERT INTO _syncmesh_state (tbl, key, record) VALUES ($1, $2, $3)
      ON CONFLICT (tbl, key) DO UPDATE SET record = excluded.record`,
    upsertCursor: `INSERT INTO _syncmesh_cursors (peer, local, seq) VALUES ($1, $2, $3)
      ON CONFLICT (peer, local) DO UPDATE SET seq = excluded.seq`,
    selectRows: `SELECT tbl, key, record FROM _syncmesh_state`,
    selectCursors: `SELECT peer, local, seq FROM _syncmesh_cursors`,
    anyCursor: `SELECT 1 FROM _syncmesh_cursors LIMIT 1`,
    clearRows: `DELETE FROM _syncmesh_state`,
    clearCursors: `DELETE FROM _syncmesh_cursors`,
    selectScope: `SELECT scope FROM _syncmesh_scope`,
    upsertScope: `INSERT INTO _syncmesh_scope (id, scope) VALUES (0, $1)
      ON CONFLICT (id) DO UPDATE SET scope = excluded.scope`,
    clearScope: `DELETE FROM _syncmesh_scope`,
  },
  docs: POSTGRES_DOCS,
  capture,
  placeholder: (position) => `$${position}`,
  cell: postgresCell,
  migrate: async (driver) => {
    await driver.run(
      `CREATE TABLE IF NOT EXISTS _syncmesh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    const [row] = await driver.all(`SELECT value FROM _syncmesh_meta WHERE key = 'version'`);
    const applied = Number(row?.[0] ?? 0);
    for (const step of POSTGRES_MIGRATIONS.slice(applied))
      for (const sql of step) await driver.run(sql);
    await driver.run(
      `INSERT INTO _syncmesh_meta (key, value) VALUES ('version', $1)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [String(POSTGRES_MIGRATIONS.length)],
    );
  },
};

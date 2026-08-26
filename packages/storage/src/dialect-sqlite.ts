import type { CellValue } from "@syncmesh/kernel";
import type { ColumnKind } from "@syncmesh/schema";

import type { Dialect } from "./dialect.js";
import type { SqlValue } from "./driver.js";

const SQLITE_COMPACTABLE = `FROM events
  WHERE local = ? AND hlc_ms < ?
    AND seq <= COALESCE((SELECT value FROM json_each(?) WHERE key = events.peer), 0)`;

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
    insert: `INSERT OR IGNORE INTO events
      (peer, seq, local, hlc_ms, hlc_logical, partition, core, sig)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    selectAll: `SELECT core, local, sig FROM events ORDER BY hlc_ms, hlc_logical, peer, seq`,
    selectSince: `SELECT core, local, sig FROM events
      WHERE local = ?
        AND seq > COALESCE((SELECT value FROM json_each(?) WHERE key = events.peer), 0)
      ORDER BY peer, seq`,
    selectHas: `SELECT 1 FROM events WHERE peer = ? AND seq = ? AND local = ? LIMIT 1`,
    selectLastSeq: `SELECT MAX(seq) FROM (
      SELECT seq FROM events WHERE peer = ?1 AND local = ?2
      UNION ALL SELECT seq FROM compaction WHERE peer = ?1 AND local = ?2)`,
    selectCompactable: `SELECT peer, MAX(seq), COUNT(*) ${SQLITE_COMPACTABLE} GROUP BY peer`,
    selectCompactableStamp: `SELECT hlc_ms, hlc_logical ${SQLITE_COMPACTABLE} AND peer = ?
      ORDER BY hlc_ms DESC, hlc_logical DESC LIMIT 1`,
    deleteCompactable: `DELETE ${SQLITE_COMPACTABLE}`,
    upsertFloor: `INSERT INTO compaction (peer, local, seq, hlc_ms, hlc_logical)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (peer, local) DO UPDATE SET
        seq = MAX(seq, excluded.seq),
        hlc_logical = CASE
          WHEN excluded.hlc_ms > hlc_ms THEN excluded.hlc_logical
          WHEN excluded.hlc_ms = hlc_ms THEN MAX(hlc_logical, excluded.hlc_logical)
          ELSE hlc_logical END,
        hlc_ms = MAX(hlc_ms, excluded.hlc_ms)`,
    selectFloors: `SELECT peer, local, seq FROM compaction`,
    selectMaxHlc: `SELECT hlc_ms, hlc_logical FROM (
      SELECT hlc_ms, hlc_logical FROM events UNION ALL SELECT hlc_ms, hlc_logical FROM compaction)
      ORDER BY hlc_ms DESC, hlc_logical DESC LIMIT 1`,
  },
  state: {
    upsertRow: `INSERT OR REPLACE INTO state_rows (tbl, key, record) VALUES (?, ?, ?)`,
    upsertCursor: `INSERT OR REPLACE INTO state_cursors (peer, local, seq) VALUES (?, ?, ?)`,
    selectRows: `SELECT tbl, key, record FROM state_rows`,
    selectCursors: `SELECT peer, local, seq FROM state_cursors`,
    anyCursor: `SELECT 1 FROM state_cursors LIMIT 1`,
    clearRows: `DELETE FROM state_rows`,
    clearCursors: `DELETE FROM state_cursors`,
  },
  placeholder: () => "?",
  cell: sqliteCell,
  migrate: async (driver) => {
    const [row] = await driver.all("PRAGMA user_version");
    const applied = Number(row?.[0] ?? 0);
    for (const step of SQLITE_MIGRATIONS.slice(applied))
      for (const sql of step) await driver.run(sql);
    await driver.run(`PRAGMA user_version = ${SQLITE_MIGRATIONS.length}`);
  },
};

import type { GapSql } from "./dialect.js";
import type { LogPlacement } from "./driver.js";

import { logTable } from "./namespace.js";

/*
 * The gap table in each dialect (D39): one migration step and one statement set apiece, like the
 * doc tables beside them. A log table — `syncmesh.gaps`, or `syncmesh_gaps` inline — because what
 * it records is a fact about how the log was written, which no fold of anything can give back.
 *
 * The step's backfill records what a log from before it already holds, which is all it can know:
 * a hole that is there when the step runs is taken as one the log was written with.
 */

/**
 * The SQLite step that creates the gap table and records the holes an older log already has, and
 * makes sure of `meta`, where the session marker is kept (D39) — so an open reads it without
 * creating anything first.
 */
export const sqliteGapTables = (log: LogPlacement): readonly string[] => {
  const t = (name: string) => logTable(name, log);
  return [
    `CREATE TABLE IF NOT EXISTS ${t("meta")} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${t("gaps")} (
      peer TEXT NOT NULL,
      local INTEGER NOT NULL,
      from_seq INTEGER NOT NULL,
      to_seq INTEGER NOT NULL,
      PRIMARY KEY (peer, local, from_seq)
    ) WITHOUT ROWID`,
    `INSERT OR IGNORE INTO ${t("gaps")} (peer, local, from_seq, to_seq)
      SELECT peer, local, prev + 1, seq - 1 FROM (
        SELECT e.peer AS peer, e.local AS local, e.seq AS seq,
          MAX(
            COALESCE(LAG(e.seq) OVER (PARTITION BY e.peer, e.local ORDER BY e.seq), 0),
            COALESCE((SELECT c.seq FROM ${t("compaction")} c WHERE c.peer = e.peer AND c.local = e.local), 0)
          ) AS prev
        FROM ${t("events")} e)
      WHERE seq > prev + 1`,
  ];
};

export const sqliteGaps = (log: LogPlacement): GapSql => {
  const gaps = logTable("gaps", log);
  return {
    insert: `INSERT OR IGNORE INTO ${gaps} (peer, local, from_seq, to_seq) VALUES (?, ?, ?, ?)`,
    selectAt: `SELECT from_seq, to_seq FROM ${gaps}
      WHERE peer = ? AND local = ? AND from_seq <= ? ORDER BY from_seq DESC LIMIT 1`,
    delete: `DELETE FROM ${gaps} WHERE peer = ? AND local = ? AND from_seq = ?`,
    selectAll: `SELECT peer, local, from_seq, to_seq FROM ${gaps} ORDER BY peer, local, from_seq`,
    selectInstalled: `SELECT value FROM ${logTable("meta", log)} WHERE key = 'installed'`,
    upsertInstalled: `INSERT OR REPLACE INTO ${logTable("meta", log)} (key, value) VALUES ('installed', ?)`,
  };
};

/** The Postgres step: the same table and backfill in `syncmesh`. */
export const POSTGRES_GAP_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS syncmesh.gaps (
    peer TEXT NOT NULL,
    local INTEGER NOT NULL,
    from_seq BIGINT NOT NULL,
    to_seq BIGINT NOT NULL,
    PRIMARY KEY (peer, local, from_seq)
  )`,
  `INSERT INTO syncmesh.gaps (peer, local, from_seq, to_seq)
    SELECT peer, local, prev + 1, seq - 1 FROM (
      SELECT e.peer, e.local, e.seq,
        GREATEST(
          COALESCE(LAG(e.seq) OVER (PARTITION BY e.peer, e.local ORDER BY e.seq), 0),
          COALESCE((SELECT c.seq FROM syncmesh.compaction c WHERE c.peer = e.peer AND c.local = e.local), 0)
        ) AS prev
      FROM syncmesh.events e) AS runs
    WHERE seq > prev + 1
    ON CONFLICT (peer, local, from_seq) DO NOTHING`,
];

export const POSTGRES_GAPS: GapSql = {
  insert: `INSERT INTO syncmesh.gaps (peer, local, from_seq, to_seq) VALUES ($1, $2, $3, $4)
    ON CONFLICT (peer, local, from_seq) DO NOTHING`,
  selectAt: `SELECT from_seq, to_seq FROM syncmesh.gaps
    WHERE peer = $1 AND local = $2 AND from_seq <= $3 ORDER BY from_seq DESC LIMIT 1`,
  delete: `DELETE FROM syncmesh.gaps WHERE peer = $1 AND local = $2 AND from_seq = $3`,
  selectAll: `SELECT peer, local, from_seq, to_seq FROM syncmesh.gaps ORDER BY peer, local, from_seq`,
  selectInstalled: `SELECT value FROM syncmesh.meta WHERE key = 'installed'`,
  upsertInstalled: `INSERT INTO syncmesh.meta (key, value) VALUES ('installed', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  // a read that found a hole looks again with the entries and the gaps from one snapshot
  snapshot: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  // two writers that both read an author's head before either commits would each record a gap
  // from it, and the second row is dropped on the key: the head is read under this lock instead
  lock: `SELECT pg_advisory_xact_lock(hashtext('syncmesh.gaps:' || $1::text), $2::int)`,
};

import type { OperationSql } from "./dialect.js";

/*
 * The write ledger's statements, one set per dialect (book ch. 10). SQLite keeps the short
 * names on the device; Postgres gets `_syncmesh_` prefixes because it is the app's own
 * database. Same shapes, same column order, so one decoder reads both.
 */

export const SQLITE_OPERATIONS: OperationSql = {
  ddl: [
    `CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      peer TEXT NOT NULL,
      seq INTEGER NOT NULL,
      label TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      hlc_ms INTEGER NOT NULL DEFAULT 0,
      hlc_logical INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      corrected_by TEXT,
      corrected_reason TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS operations_event ON operations (peer, seq)`,
    `CREATE TABLE IF NOT EXISTS receipts (
      peer TEXT NOT NULL,
      seq INTEGER NOT NULL,
      holder TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      PRIMARY KEY (peer, seq, holder)
    )`,
  ],
  insertOp: `INSERT INTO operations (id, peer, seq, label, at_ms, hlc_ms, hlc_logical, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  selectOp: `SELECT id, peer, seq, label, at_ms, status, corrected_by, corrected_reason
    FROM operations WHERE id = ?`,
  selectOpByEvent: `SELECT id, peer, seq, label, at_ms, status, corrected_by, corrected_reason
    FROM operations WHERE peer = ? AND seq = ?`,
  selectUnsettled: `SELECT o.id, o.peer, o.seq, o.label, o.at_ms, o.status, o.corrected_by, o.corrected_reason
    FROM operations o LEFT JOIN receipts r ON r.peer = o.peer AND r.seq = o.seq
    WHERE r.peer IS NULL ORDER BY o.at_ms, o.seq`,
  markCorrected: `UPDATE operations SET status = 'superseded', corrected_by = ?, corrected_reason = ?
    WHERE peer = ? AND seq = ?`,
  insertReceiptsThrough: `INSERT OR IGNORE INTO receipts (peer, seq, holder, at_ms)
    SELECT peer, seq, ?, ? FROM operations WHERE peer = ? AND seq <= ?`,
  selectReceipts: `SELECT holder, at_ms FROM receipts WHERE peer = ? AND seq = ? ORDER BY at_ms, holder`,
};

export const POSTGRES_OPERATIONS: OperationSql = {
  ddl: [
    `CREATE TABLE IF NOT EXISTS _syncmesh_operations (
      id TEXT PRIMARY KEY,
      peer TEXT NOT NULL,
      seq BIGINT NOT NULL,
      label TEXT NOT NULL,
      at_ms BIGINT NOT NULL,
      hlc_ms BIGINT NOT NULL DEFAULT 0,
      hlc_logical INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      corrected_by TEXT,
      corrected_reason TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS _syncmesh_operations_event ON _syncmesh_operations (peer, seq)`,
    `CREATE TABLE IF NOT EXISTS _syncmesh_receipts (
      peer TEXT NOT NULL,
      seq BIGINT NOT NULL,
      holder TEXT NOT NULL,
      at_ms BIGINT NOT NULL,
      PRIMARY KEY (peer, seq, holder)
    )`,
  ],
  insertOp: `INSERT INTO _syncmesh_operations (id, peer, seq, label, at_ms, hlc_ms, hlc_logical, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  selectOp: `SELECT id, peer, seq, label, at_ms, status, corrected_by, corrected_reason
    FROM _syncmesh_operations WHERE id = $1`,
  selectOpByEvent: `SELECT id, peer, seq, label, at_ms, status, corrected_by, corrected_reason
    FROM _syncmesh_operations WHERE peer = $1 AND seq = $2`,
  selectUnsettled: `SELECT o.id, o.peer, o.seq, o.label, o.at_ms, o.status, o.corrected_by, o.corrected_reason
    FROM _syncmesh_operations o
    LEFT JOIN _syncmesh_receipts r ON r.peer = o.peer AND r.seq = o.seq
    WHERE r.peer IS NULL ORDER BY o.at_ms, o.seq`,
  markCorrected: `UPDATE _syncmesh_operations SET status = 'superseded', corrected_by = $1, corrected_reason = $2
    WHERE peer = $3 AND seq = $4`,
  insertReceiptsThrough: `INSERT INTO _syncmesh_receipts (peer, seq, holder, at_ms)
    SELECT peer, seq, $1, $2 FROM _syncmesh_operations WHERE peer = $3 AND seq <= $4
    ON CONFLICT DO NOTHING`,
  selectReceipts: `SELECT holder, at_ms FROM _syncmesh_receipts WHERE peer = $1 AND seq = $2
    ORDER BY at_ms, holder`,
};

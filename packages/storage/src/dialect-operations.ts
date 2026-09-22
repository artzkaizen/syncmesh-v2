import type { OperationSql } from "./dialect.js";
import type { LogPlacement } from "./driver.js";

import { logTable, sqliteLogIndex } from "./namespace.js";

/*
 * The write ledger's statements, one set per dialect (book ch. 10).
 *
 * One namespace, spelled the way each runtime can spell it: `syncmesh.operations` in a real
 * schema on Postgres, the same in an attached database on a device, and `syncmesh_operations`
 * where there is one database and no `ATTACH` to be had. Same shapes, same column order, so one
 * decoder reads all three.
 */

export const sqliteOperations = (log: LogPlacement): OperationSql => {
  const t = (name: string) => logTable(name, log);
  const indexDdl = sqliteLogIndex(log);
  return {
    ddl: [
      `CREATE TABLE IF NOT EXISTS ${t("operations")} (
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
      indexDdl("operations_event", "operations", "(peer, seq)", { unique: true }),
      `CREATE TABLE IF NOT EXISTS ${t("receipts")} (
      peer TEXT NOT NULL,
      seq INTEGER NOT NULL,
      holder TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      PRIMARY KEY (peer, seq, holder)
    )`,
      // signed custody, beside the claims rather than a column on them (D28): a cursor and a
      // signature are different facts with different provenance, and the only way to keep them
      // from being read as one is to keep them from being stored as one
      `CREATE TABLE IF NOT EXISTS ${t("vouches")} (
      peer TEXT NOT NULL,
      seq INTEGER NOT NULL,
      holder TEXT NOT NULL,
      incarnation TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      PRIMARY KEY (peer, seq, holder)
    )`,
      indexDdl("vouches_holder", "vouches", "(holder, incarnation)"),
    ],
    insertOp: `INSERT INTO ${t("operations")} (id, peer, seq, label, at_ms, hlc_ms, hlc_logical, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    selectOp: `SELECT id, peer, seq, label, at_ms, status, corrected_by, corrected_reason
    FROM ${t("operations")} WHERE id = ?`,
    selectOpByEvent: `SELECT id, peer, seq, label, at_ms, status, corrected_by, corrected_reason
    FROM ${t("operations")} WHERE peer = ? AND seq = ?`,
    selectUnsettled: `SELECT o.id, o.peer, o.seq, o.label, o.at_ms, o.status, o.corrected_by, o.corrected_reason
    FROM ${t("operations")} o LEFT JOIN ${t("receipts")} r ON r.peer = o.peer AND r.seq = o.seq
    WHERE r.peer IS NULL ORDER BY o.at_ms, o.seq`,
    markCorrected: `UPDATE ${t("operations")} SET status = 'superseded', corrected_by = ?, corrected_reason = ?
    WHERE peer = ? AND seq = ?`,
    insertReceiptsThrough: `INSERT OR IGNORE INTO ${t("receipts")} (peer, seq, holder, at_ms)
    SELECT peer, seq, ?, ? FROM ${t("operations")} WHERE peer = ? AND seq <= ?`,
    selectReceipts: `SELECT holder, at_ms FROM ${t("receipts")} WHERE peer = ? AND seq = ? ORDER BY at_ms, holder`,
    selectSoleCustody: `SELECT o.id, o.peer, o.seq, o.label, o.at_ms, o.status, o.corrected_by, o.corrected_reason
    FROM ${t("operations")} o LEFT JOIN ${t("vouches")} v ON v.peer = o.peer AND v.seq = o.seq
    WHERE v.peer IS NULL ORDER BY o.at_ms, o.seq`,
    deleteStaleVouches: `DELETE FROM ${t("vouches")} WHERE holder = ? AND incarnation <> ?`,
    insertVouchesThrough: `INSERT OR REPLACE INTO ${t("vouches")} (peer, seq, holder, incarnation, at_ms)
    SELECT peer, seq, ?, ?, ? FROM ${t("operations")} WHERE peer = ? AND seq <= ?`,
    selectVouches: `SELECT holder, incarnation, at_ms FROM ${t("vouches")} WHERE peer = ? AND seq = ?
    ORDER BY at_ms, holder`,
  };
};

export const POSTGRES_OPERATIONS: OperationSql = {
  ddl: [
    `CREATE TABLE IF NOT EXISTS syncmesh.operations (
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
    `CREATE UNIQUE INDEX IF NOT EXISTS operations_event ON syncmesh.operations (peer, seq)`,
    `CREATE TABLE IF NOT EXISTS syncmesh.receipts (
      peer TEXT NOT NULL,
      seq BIGINT NOT NULL,
      holder TEXT NOT NULL,
      at_ms BIGINT NOT NULL,
      PRIMARY KEY (peer, seq, holder)
    )`,
    `CREATE TABLE IF NOT EXISTS syncmesh.vouches (
      peer TEXT NOT NULL,
      seq BIGINT NOT NULL,
      holder TEXT NOT NULL,
      incarnation TEXT NOT NULL,
      at_ms BIGINT NOT NULL,
      PRIMARY KEY (peer, seq, holder)
    )`,
    `CREATE INDEX IF NOT EXISTS vouches_holder ON syncmesh.vouches (holder, incarnation)`,
  ],
  insertOp: `INSERT INTO syncmesh.operations (id, peer, seq, label, at_ms, hlc_ms, hlc_logical, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  selectOp: `SELECT id, peer, seq, label, at_ms, status, corrected_by, corrected_reason
    FROM syncmesh.operations WHERE id = $1`,
  selectOpByEvent: `SELECT id, peer, seq, label, at_ms, status, corrected_by, corrected_reason
    FROM syncmesh.operations WHERE peer = $1 AND seq = $2`,
  selectUnsettled: `SELECT o.id, o.peer, o.seq, o.label, o.at_ms, o.status, o.corrected_by, o.corrected_reason
    FROM syncmesh.operations o
    LEFT JOIN syncmesh.receipts r ON r.peer = o.peer AND r.seq = o.seq
    WHERE r.peer IS NULL ORDER BY o.at_ms, o.seq`,
  markCorrected: `UPDATE syncmesh.operations SET status = 'superseded', corrected_by = $1, corrected_reason = $2
    WHERE peer = $3 AND seq = $4`,
  insertReceiptsThrough: `INSERT INTO syncmesh.receipts (peer, seq, holder, at_ms)
    SELECT peer, seq, $1, $2 FROM syncmesh.operations WHERE peer = $3 AND seq <= $4
    ON CONFLICT DO NOTHING`,
  selectReceipts: `SELECT holder, at_ms FROM syncmesh.receipts WHERE peer = $1 AND seq = $2
    ORDER BY at_ms, holder`,
  selectSoleCustody: `SELECT o.id, o.peer, o.seq, o.label, o.at_ms, o.status, o.corrected_by, o.corrected_reason
    FROM syncmesh.operations o
    LEFT JOIN syncmesh.vouches v ON v.peer = o.peer AND v.seq = o.seq
    WHERE v.peer IS NULL ORDER BY o.at_ms, o.seq`,
  deleteStaleVouches: `DELETE FROM syncmesh.vouches WHERE holder = $1 AND incarnation <> $2`,
  insertVouchesThrough: `INSERT INTO syncmesh.vouches (peer, seq, holder, incarnation, at_ms)
    SELECT peer, seq, $1, $2, $3 FROM syncmesh.operations WHERE peer = $4 AND seq <= $5
    ON CONFLICT (peer, seq, holder) DO UPDATE SET incarnation = EXCLUDED.incarnation, at_ms = EXCLUDED.at_ms`,
  selectVouches: `SELECT holder, incarnation, at_ms FROM syncmesh.vouches WHERE peer = $1 AND seq = $2
    ORDER BY at_ms, holder`,
};

import type { DocSql } from "./dialect.js";

import { stateTable } from "./namespace.js";

/*
 * The doc log and heads in each dialect (RFC-0023 §6.2): one migration step and one statement set
 * apiece, beside the Drizzle declarations in `doc-tables.ts` that `driver-tests/docs.ts` holds the
 * created tables to. Entry columns in the order `DocSql` documents.
 *
 * Named by `namespace.ts`, as derived tables: `syncmesh.doc_log`, `syncmesh.doc_heads` and
 * `syncmesh.doc_snapshots` in Postgres's own schema, `syncmesh_doc_log`, `syncmesh_doc_heads` and
 * `syncmesh_doc_snapshots` in a device's `main`, so an app table called `doc_log` is never the one
 * these statements reach. All three sit in the derived half because an entry's `state` moves in
 * the same transaction as its head and the column's snapshot, which live in `main`.
 */

const SQLITE_LOG = stateTable("doc_log", "sqlite");
const SQLITE_HEADS = stateTable("doc_heads", "sqlite");
const PG_LOG = stateTable("doc_log", "postgres");
const PG_HEADS = stateTable("doc_heads", "postgres");
const SQLITE_SNAPSHOTS = stateTable("doc_snapshots", "sqlite");
const PG_SNAPSHOTS = stateTable("doc_snapshots", "postgres");

const ENTRY =
  "author, seq, idx, tbl, key, col, lineage, hlc_ms, hlc_logical, action, undo_of, blob, size, state";
const HEAD =
  "tbl, key, col, adapter, lineage, covers, version, tail_count, tail_bytes, mode, materialised_at";

/** The SQLite migration step that creates `syncmesh_doc_log` and `syncmesh_doc_heads`. */
export const SQLITE_DOC_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${SQLITE_LOG} (
    author TEXT NOT NULL,
    seq INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    tbl TEXT NOT NULL,
    key TEXT NOT NULL,
    col TEXT NOT NULL,
    lineage BLOB,
    hlc_ms INTEGER NOT NULL,
    hlc_logical INTEGER NOT NULL,
    action BLOB,
    undo_of BLOB,
    blob TEXT,
    size INTEGER NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (author, seq, idx)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS syncmesh_doc_log_doc ON ${SQLITE_LOG} (tbl, key, col, state)`,
  `CREATE TABLE IF NOT EXISTS ${SQLITE_HEADS} (
    tbl TEXT NOT NULL,
    key TEXT NOT NULL,
    col TEXT NOT NULL,
    adapter TEXT NOT NULL,
    lineage BLOB,
    covers TEXT NOT NULL,
    version BLOB,
    tail_count INTEGER NOT NULL,
    tail_bytes INTEGER NOT NULL,
    mode TEXT NOT NULL,
    materialised_at INTEGER,
    PRIMARY KEY (tbl, key, col)
  ) WITHOUT ROWID`,
];

/**
 * The column snapshots (RFC-0023 §6.1), a step of their own after the log and heads: a database
 * migrated before materialisation existed gains the table and keeps everything else.
 */
export const SQLITE_DOC_SNAPSHOTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${SQLITE_SNAPSHOTS} (
    tbl TEXT NOT NULL,
    key TEXT NOT NULL,
    col TEXT NOT NULL,
    lineage BLOB,
    bytes BLOB NOT NULL,
    PRIMARY KEY (tbl, key, col)
  ) WITHOUT ROWID`,
];

export const SQLITE_DOCS: DocSql = {
  insertEntry: `INSERT OR IGNORE INTO ${SQLITE_LOG} (${ENTRY}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  selectEntries: `SELECT ${ENTRY} FROM ${SQLITE_LOG} ORDER BY author, seq, idx`,
  selectDocEntries: `SELECT ${ENTRY} FROM ${SQLITE_LOG} WHERE tbl = ? AND key = ? AND col = ?
    ORDER BY author, seq, idx`,
  updateState: `UPDATE ${SQLITE_LOG} SET state = ? WHERE author = ? AND seq = ? AND idx = ?`,
  upsertHead: `INSERT INTO ${SQLITE_HEADS} (${HEAD})
    VALUES (?, ?, ?, ?, ?, '{}', NULL, ?, ?, 'none', NULL)
    ON CONFLICT (tbl, key, col) DO UPDATE SET adapter = excluded.adapter,
      lineage = excluded.lineage, tail_count = excluded.tail_count,
      tail_bytes = excluded.tail_bytes`,
  selectHeads: `SELECT ${HEAD} FROM ${SQLITE_HEADS} ORDER BY tbl, key, col`,
  selectUncovered: `SELECT author, MIN(seq) FROM ${SQLITE_LOG} WHERE state <> 'covered' GROUP BY author`,
  coverHead: `INSERT INTO ${SQLITE_HEADS} (${HEAD})
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    ON CONFLICT (tbl, key, col) DO UPDATE SET adapter = excluded.adapter,
      lineage = excluded.lineage, covers = excluded.covers, version = excluded.version,
      mode = excluded.mode, materialised_at = excluded.materialised_at`,
  countTail: `UPDATE ${SQLITE_HEADS} SET tail_count = ?, tail_bytes = ? WHERE tbl = ? AND key = ? AND col = ?`,
  upsertSnapshot: `INSERT INTO ${SQLITE_SNAPSHOTS} (tbl, key, col, lineage, bytes) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (tbl, key, col) DO UPDATE SET lineage = excluded.lineage, bytes = excluded.bytes`,
  selectSnapshot: `SELECT lineage, bytes FROM ${SQLITE_SNAPSHOTS} WHERE tbl = ? AND key = ? AND col = ?`,
};

/** The Postgres migration step that creates `syncmesh.doc_log` and `syncmesh.doc_heads`. */
export const POSTGRES_DOC_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${PG_LOG} (
    author TEXT NOT NULL,
    seq BIGINT NOT NULL,
    idx INTEGER NOT NULL,
    tbl TEXT NOT NULL,
    key TEXT NOT NULL,
    col TEXT NOT NULL,
    lineage BYTEA,
    hlc_ms BIGINT NOT NULL,
    hlc_logical INTEGER NOT NULL,
    action BYTEA,
    undo_of BYTEA,
    blob TEXT,
    size INTEGER NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (author, seq, idx)
  )`,
  `CREATE INDEX IF NOT EXISTS doc_log_doc ON ${PG_LOG} (tbl, key, col, state)`,
  `CREATE TABLE IF NOT EXISTS ${PG_HEADS} (
    tbl TEXT NOT NULL,
    key TEXT NOT NULL,
    col TEXT NOT NULL,
    adapter TEXT NOT NULL,
    lineage BYTEA,
    covers TEXT NOT NULL,
    version BYTEA,
    tail_count INTEGER NOT NULL,
    tail_bytes BIGINT NOT NULL,
    mode TEXT NOT NULL,
    materialised_at BIGINT,
    PRIMARY KEY (tbl, key, col)
  )`,
];

export const POSTGRES_DOC_SNAPSHOTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${PG_SNAPSHOTS} (
    tbl TEXT NOT NULL,
    key TEXT NOT NULL,
    col TEXT NOT NULL,
    lineage BYTEA,
    bytes BYTEA NOT NULL,
    PRIMARY KEY (tbl, key, col)
  )`,
];

export const POSTGRES_DOCS: DocSql = {
  insertEntry: `INSERT INTO ${PG_LOG} (${ENTRY})
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (author, seq, idx) DO NOTHING`,
  selectEntries: `SELECT ${ENTRY} FROM ${PG_LOG} ORDER BY author, seq, idx`,
  selectDocEntries: `SELECT ${ENTRY} FROM ${PG_LOG} WHERE tbl = $1 AND key = $2 AND col = $3
    ORDER BY author, seq, idx`,
  updateState: `UPDATE ${PG_LOG} SET state = $1 WHERE author = $2 AND seq = $3 AND idx = $4`,
  upsertHead: `INSERT INTO ${PG_HEADS} (${HEAD})
    VALUES ($1, $2, $3, $4, $5, '{}', NULL, $6, $7, 'none', NULL)
    ON CONFLICT (tbl, key, col) DO UPDATE SET adapter = excluded.adapter,
      lineage = excluded.lineage, tail_count = excluded.tail_count,
      tail_bytes = excluded.tail_bytes`,
  selectHeads: `SELECT ${HEAD} FROM ${PG_HEADS} ORDER BY tbl, key, col`,
  selectUncovered: `SELECT author, MIN(seq) FROM ${PG_LOG} WHERE state <> 'covered'
    GROUP BY author`,
  coverHead: `INSERT INTO ${PG_HEADS} (${HEAD})
    VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, $9)
    ON CONFLICT (tbl, key, col) DO UPDATE SET adapter = excluded.adapter,
      lineage = excluded.lineage, covers = excluded.covers, version = excluded.version,
      mode = excluded.mode, materialised_at = excluded.materialised_at`,
  countTail: `UPDATE ${PG_HEADS} SET tail_count = $1, tail_bytes = $2
    WHERE tbl = $3 AND key = $4 AND col = $5`,
  upsertSnapshot: `INSERT INTO ${PG_SNAPSHOTS} (tbl, key, col, lineage, bytes)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (tbl, key, col) DO UPDATE SET lineage = excluded.lineage, bytes = excluded.bytes`,
  selectSnapshot: `SELECT lineage, bytes FROM ${PG_SNAPSHOTS}
    WHERE tbl = $1 AND key = $2 AND col = $3`,
};

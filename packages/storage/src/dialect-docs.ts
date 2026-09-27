import type { DocSql } from "./dialect.js";

/*
 * The doc log and heads in each dialect (RFC-0023 §6.2): one migration step and one statement set
 * apiece, beside the Drizzle declarations in `doc-tables.ts` that `driver-tests/docs.ts` holds the
 * created tables to. Entry columns in the order `DocSql` documents.
 */

const ENTRY =
  "author, seq, idx, tbl, key, col, lineage, hlc_ms, hlc_logical, action, undo_of, blob, size, state";
const HEAD =
  "tbl, key, col, adapter, lineage, covers, version, tail_count, tail_bytes, mode, materialised_at";

/** The SQLite migration step that creates `doc_log` and `doc_heads`. */
export const SQLITE_DOC_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS doc_log (
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
  `CREATE INDEX IF NOT EXISTS doc_log_doc ON doc_log (tbl, key, col, state)`,
  `CREATE TABLE IF NOT EXISTS doc_heads (
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

export const SQLITE_DOCS: DocSql = {
  insertEntry: `INSERT OR IGNORE INTO doc_log (${ENTRY}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  selectEntries: `SELECT ${ENTRY} FROM doc_log ORDER BY author, seq, idx`,
  selectDocEntries: `SELECT ${ENTRY} FROM doc_log WHERE tbl = ? AND key = ? AND col = ?
    ORDER BY author, seq, idx`,
  updateState: `UPDATE doc_log SET state = ? WHERE author = ? AND seq = ? AND idx = ?`,
  upsertHead: `INSERT INTO doc_heads (${HEAD})
    VALUES (?, ?, ?, ?, ?, '{}', NULL, ?, ?, 'none', NULL)
    ON CONFLICT (tbl, key, col) DO UPDATE SET adapter = excluded.adapter,
      lineage = excluded.lineage, tail_count = excluded.tail_count,
      tail_bytes = excluded.tail_bytes`,
  selectHeads: `SELECT ${HEAD} FROM doc_heads ORDER BY tbl, key, col`,
  selectUncovered: `SELECT author, MIN(seq) FROM doc_log WHERE state <> 'covered' GROUP BY author`,
};

/** The Postgres migration step that creates `_syncmesh_doc_log` and `_syncmesh_doc_heads`. */
export const POSTGRES_DOC_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS _syncmesh_doc_log (
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
  `CREATE INDEX IF NOT EXISTS _syncmesh_doc_log_doc ON _syncmesh_doc_log (tbl, key, col, state)`,
  `CREATE TABLE IF NOT EXISTS _syncmesh_doc_heads (
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

export const POSTGRES_DOCS: DocSql = {
  insertEntry: `INSERT INTO _syncmesh_doc_log (${ENTRY})
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (author, seq, idx) DO NOTHING`,
  selectEntries: `SELECT ${ENTRY} FROM _syncmesh_doc_log ORDER BY author, seq, idx`,
  selectDocEntries: `SELECT ${ENTRY} FROM _syncmesh_doc_log WHERE tbl = $1 AND key = $2 AND col = $3
    ORDER BY author, seq, idx`,
  updateState: `UPDATE _syncmesh_doc_log SET state = $1 WHERE author = $2 AND seq = $3 AND idx = $4`,
  upsertHead: `INSERT INTO _syncmesh_doc_heads (${HEAD})
    VALUES ($1, $2, $3, $4, $5, '{}', NULL, $6, $7, 'none', NULL)
    ON CONFLICT (tbl, key, col) DO UPDATE SET adapter = excluded.adapter,
      lineage = excluded.lineage, tail_count = excluded.tail_count,
      tail_bytes = excluded.tail_bytes`,
  selectHeads: `SELECT ${HEAD} FROM _syncmesh_doc_heads ORDER BY tbl, key, col`,
  selectUncovered: `SELECT author, MIN(seq) FROM _syncmesh_doc_log WHERE state <> 'covered'
    GROUP BY author`,
};

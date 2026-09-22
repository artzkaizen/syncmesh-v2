import type { CellValue, ColumnName, TableName } from "@syncmesh/kernel";
import type { ColumnKind, Table } from "@syncmesh/schema";

import type { SqlDialect, SqlDriver, SqlValue } from "./driver.js";

import { POSTGRES } from "./dialect-postgres.js";
import { SQLITE, SQLITE_INLINE } from "./dialect-sqlite.js";

export {
  ATTACHED_LOG,
  LOG_TABLES,
  STATE_TABLES,
  logTable,
  namespaceDdl,
  placementOf,
  sqliteLogIndex,
  stateTable,
} from "./namespace.js";

/*
 * One set of statements per dialect, keyed by the same names, so a store is written once and
 * never interpolates its way from one SQL to another. SQLite keeps its short table names on the
 * device; Postgres gets `_syncmesh_` prefixes because it is the app's own database and `events`
 * is somebody's table.
 */

export interface EventSql {
  readonly insert: string;
  readonly selectAll: string;
  /**
   * The tail by stamp, newest first, with `length(core)` in place of the core itself — one page
   * of headers, over the `hlc` index the log has carried since its first migration.
   *
   * Binds `(hlc_ms, hlc_logical, limit)` in that order in both dialects, which is why SQLite
   * numbers its markers here: an open cursor is a stamp above every stored one, so the caller
   * always binds three and the statement never has two shapes.
   */
  readonly selectRecent: string;
  readonly selectSince: string;
  /**
   * The rows with no signature whose author is not the bound peer — what a device can never send.
   *
   * A predicate rather than a walk, because the answer on a healthy log is no rows and the cost
   * of asking should match: nothing is decoded, nothing is paged, and the audit `openEngine` runs
   * at every boot stays a single statement. Binds `(peer)`.
   */
  readonly selectStranded: string;
  readonly selectHas: string;
  readonly selectLastSeq: string;
  readonly selectCompactable: string;
  readonly selectCompactableStamp: string;
  readonly deleteCompactable: string;
  readonly upsertFloor: string;
  readonly selectFloors: string;
  readonly selectMaxHlc: string;
}

export interface StateSql {
  readonly upsertRow: string;
  readonly upsertCursor: string;
  readonly selectRows: string;
  readonly selectCursors: string;
  readonly anyCursor: string;
  readonly clearRows: string;
  readonly clearCursors: string;
  /** The interest the cursors are true for, one row or none (D23); absent means unscoped. */
  readonly selectScope: string;
  readonly upsertScope: string;
  readonly clearScope: string;
}

/**
 * Change capture in one dialect (D20 §3): the table DDL, the log and its triggers, and the four
 * statements a capture runs around the app's own. The logged image is the same shape in every
 * dialect — bytes as lowercase hex, timestamps as epoch milliseconds, JSON as its text — so one
 * decoder reads it back.
 */
/**
 * The one row that records which app schema this database was last opened with.
 *
 * In `meta`, beside the migration version, because they are the same kind of fact — what shape
 * this database is already at — and a second table for the second one would have been a table
 * per question.
 */
export interface SchemaSql {
  /** Creates `meta` where it does not exist. The one statement a launch always runs. */
  readonly ddl: string;
  /** The fingerprint last installed, or no rows on a database that has never been opened. */
  readonly read: string;
  /** Writes it, under this dialect's own placeholder. */
  readonly write: string;
}

export interface CaptureSql {
  /** `CREATE TABLE IF NOT EXISTS` for a synced table: its columns plus `_partition`, only the key constrained. */
  readonly tableDdl: (table: Table) => string;
  /** The log and one trigger set per table; idempotent, so installing twice is installing once. */
  readonly captureDdl: (tables: readonly Table[]) => readonly string[];
  /** Triggers log only between these two, inside the transaction. */
  readonly arm: string;
  readonly disarm: string;
  /** `tbl, key, op, old, new` in log order. */
  readonly selectLog: string;
  readonly clearLog: string;
  /** Stamps the partition (bind 1) onto the row with this key (bind 2), guard at rest. */
  readonly stampPartition: (table: TableName, pk: ColumnName, partitionColumn: string) => string;
}

/**
 * The write's durable record and its custody receipts (book ch. 10): what survives kill-9 so a
 * caller can look an ambiguous outcome up instead of retrying into a duplicate.
 */
export interface OperationSql {
  /** Every table and index of the ledger; idempotent, run on open. */
  readonly ddl: readonly string[];
  /** `id, peer, seq, label, at_ms, status`. */
  readonly insertOp: string;
  /** The full row by op id. */
  readonly selectOp: string;
  /** The full row by the event it became — `peer, seq`. */
  readonly selectOpByEvent: string;
  /** Every op no peer has claimed custody of yet, oldest first. */
  readonly selectUnsettled: string;
  /** Every op no peer has **signed** for, oldest first — what licenses nothing while it is listed (D28). */
  readonly selectSoleCustody: string;
  /** `corrected_by, corrected_reason, peer, seq` — the displaced write learns why (ch. 20). */
  readonly markCorrected: string;
  /** `holder, at_ms, author, through_seq`: one receipt per op the holder's cursor now covers. */
  readonly insertReceiptsThrough: string;
  /** `holder, at_ms` per receipt of one event — `peer, seq`. */
  readonly selectReceipts: string;
  /**
   * `holder, incarnation`: forgets every vouch a holder made under a lineage it no longer has.
   *
   * Run before each insert, so learning that a peer rebuilt its store is what takes away the
   * custody it claimed with the store it lost. This is the whole reason a receipt carries an
   * incarnation at all — without it a wiped relay goes on counting as a holder forever.
   */
  readonly deleteStaleVouches: string;
  /** `holder, incarnation, at_ms, author, through_seq`: one vouch per op the signature covers. */
  readonly insertVouchesThrough: string;
  /** `holder, incarnation, at_ms` per vouch of one event — `peer, seq`. */
  readonly selectVouches: string;
}

export interface Dialect {
  readonly name: SqlDialect;
  readonly events: EventSql;
  readonly state: StateSql;
  readonly capture: CaptureSql;
  readonly operations: OperationSql;
  /** The bind marker for the 1-based position — `?` or `$n`. */
  readonly placeholder: (position: number) => string;
  /** A cell in the form the column's SQL type holds it in this dialect. */
  readonly cell: (kind: ColumnKind, cell: CellValue) => SqlValue;
  /** Brings the mesh's own tables up to date; a no-op when they already are. */
  readonly migrate: (driver: SqlDriver) => Promise<void>;
  /**
   * Where the app-schema fingerprint lives, so a launch that changed nothing installs nothing.
   *
   * The engine's own tables are versioned by {@link SqlDialect.migrate}; these are the ones
   * derived from the *app's* manifest — a table and a trigger set per synced table — which have
   * no version to compare because they are whatever the manifest currently says. The fingerprint
   * is that: identical text means an identical shape, and nothing to do.
   */
  readonly schema: SchemaSql;
}

export const dialectOf = (driver: Pick<SqlDriver, "dialect" | "log">): Dialect => {
  if (driver.dialect === "postgres") return POSTGRES;
  return driver.log === "inline" ? SQLITE_INLINE : SQLITE;
};

export { POSTGRES, SQLITE, SQLITE_INLINE };

import type { CellValue, ColumnName, TableName } from "@syncmesh/kernel";
import type { ColumnKind, Table } from "@syncmesh/schema";

import type { SqlDialect, SqlDriver, SqlValue } from "./driver.js";

import { POSTGRES } from "./dialect-postgres.js";
import { SQLITE } from "./dialect-sqlite.js";

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
 * Where the log lives, and therefore how its tables are spelled.
 *
 * SQLite has no schemas, so the log is a **second file attached under the name `syncmesh`** —
 * which is the one mechanism that gives real `syncmesh.events` there, and the reason the durable
 * half can be backed up, vacuumed and reasoned about on its own (RFC-0022). Postgres has one
 * database and one `CREATE SCHEMA syncmesh`, so both halves already live under that name.
 *
 * The derived half is whatever the connection opened as `main`, because the app's own tables are
 * there and must stay unqualified: every Drizzle query in every procedure names them directly,
 * and a trigger cannot write across an attached database anyway. So the engine's derived tables
 * share `main` with the app's and take a `syncmesh_` prefix to stay out of their way.
 */
export const ATTACHED_LOG = "syncmesh";

/**
 * A durable table: the log's own. `syncmesh.events` on both dialects — an attached database on
 * SQLite, a schema on Postgres — because the durable half is the half that is named the same
 * everywhere, and a reader should not have to know which mechanism is underneath.
 */
export const logTable = (name: string): string => `${ATTACHED_LOG}.${name}`;

/**
 * A derived table: rebuilt by folding the log, up to a compaction floor (see `refoldable`).
 *
 * `syncmesh.state_rows` on Postgres, where one schema holds both halves; `syncmesh_state_rows` on
 * SQLite, where this half shares `main` with the app's own tables and a prefix is the only
 * separator available.
 */
export const stateTable = (name: string, dialect: SqlDialect = "sqlite"): string =>
  dialect === "postgres" ? `${ATTACHED_LOG}.${name}` : `${ATTACHED_LOG}_${name}`;

/** @deprecated Say which half it is: {@link logTable} or {@link stateTable}. */
export const engineTable = (name: string, dialect: SqlDialect = "sqlite"): string =>
  stateTable(name, dialect);

/**
 * Making the namespace, for a dialect that has one to make.
 *
 * Every store here creates its own tables and several are opened directly — a blob store without
 * an event store, capture without either — so "the schema exists" cannot be something only
 * `migrate` arranges. Each of them runs this first instead, and on SQLite it is nothing.
 *
 * The grants restore exactly the reach these tables had in `public` and add none: a schema is a
 * permission boundary that `public` was not, and a role that could read them yesterday would
 * otherwise fail to resolve their names today. Row-level security is what guards the app's data
 * (`rls.ts`), and permission to *name* a table is not permission to read a row of it.
 */
export const namespaceDdl = (dialect: SqlDialect): readonly string[] =>
  dialect === "postgres"
    ? [
        `CREATE SCHEMA IF NOT EXISTS syncmesh`,
        `GRANT USAGE ON SCHEMA syncmesh TO PUBLIC`,
        `GRANT ALL ON ALL TABLES IN SCHEMA syncmesh TO PUBLIC`,
        `GRANT USAGE ON ALL SEQUENCES IN SCHEMA syncmesh TO PUBLIC`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA syncmesh GRANT ALL ON TABLES TO PUBLIC`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA syncmesh GRANT USAGE ON SEQUENCES TO PUBLIC`,
      ]
    : [];

/**
 * Which half of the store each engine table belongs to (RFC-0022).
 *
 * **The durable half cannot be recomputed; the derived half can** — up to a compaction floor, and
 * `refoldable` is the runtime form of that caveat. Written down as data rather than prose because
 * three separate things need to agree on it and each of them drifts on its own otherwise: what a
 * backup has to include, what may be discarded and refolded, and which file each table lands in
 * if the two are ever separated.
 *
 * Splitting them into two SQLite files is *not* done, and the reason is written in the RFC: on
 * SQLite a second file means `ATTACH`, which renames every table in it, and the migration ladder
 * is keyed on `PRAGMA user_version` of `main` — one counter that would then be tracking two
 * schemas with two histories. That is a migration design, not a refactor, and the split's
 * remaining prizes (a cheaper `VACUUM`, a smaller backup) do not pay for it yet.
 */
export const LOG_TABLES = [
  "events",
  "compaction",
  "scope",
  "operations",
  "receipts",
  "grants",
  "blobs",
  "meta",
] as const;

/** The other half: a pure function of {@link LOG_TABLES}, while `refoldable` says so. */
export const STATE_TABLES = [
  "state_rows",
  "cursors",
  "row_sync",
  "acked",
  "changes",
  "capture",
] as const;

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
  /** Both tables and their indexes; idempotent, run on open. */
  readonly ddl: readonly string[];
  /** `id, peer, seq, label, at_ms, status`. */
  readonly insertOp: string;
  /** The full row by op id. */
  readonly selectOp: string;
  /** The full row by the event it became — `peer, seq`. */
  readonly selectOpByEvent: string;
  /** Every op no peer has receipted yet, oldest first. */
  readonly selectUnsettled: string;
  /** `corrected_by, corrected_reason, peer, seq` — the displaced write learns why (ch. 20). */
  readonly markCorrected: string;
  /** `holder, at_ms, author, through_seq`: one receipt per op the holder's cursor now covers. */
  readonly insertReceiptsThrough: string;
  /** `holder, at_ms` per receipt of one event — `peer, seq`. */
  readonly selectReceipts: string;
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

export const dialectOf = (driver: SqlDriver): Dialect =>
  driver.dialect === "postgres" ? POSTGRES : SQLITE;

export { POSTGRES, SQLITE };

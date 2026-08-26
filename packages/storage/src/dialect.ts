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
  readonly selectSince: string;
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
}

/**
 * Change capture in one dialect (D20 §3): the table DDL, the log and its triggers, and the four
 * statements a capture runs around the app's own. The logged image is the same shape in every
 * dialect — bytes as lowercase hex, timestamps as epoch milliseconds, JSON as its text — so one
 * decoder reads it back.
 */
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

export interface Dialect {
  readonly name: SqlDialect;
  readonly events: EventSql;
  readonly state: StateSql;
  readonly capture: CaptureSql;
  /** The bind marker for the 1-based position — `?` or `$n`. */
  readonly placeholder: (position: number) => string;
  /** A cell in the form the column's SQL type holds it in this dialect. */
  readonly cell: (kind: ColumnKind, cell: CellValue) => SqlValue;
  /** Brings the mesh's own tables up to date; a no-op when they already are. */
  readonly migrate: (driver: SqlDriver) => Promise<void>;
}

export const dialectOf = (driver: SqlDriver): Dialect =>
  driver.dialect === "postgres" ? POSTGRES : SQLITE;

export { POSTGRES, SQLITE };

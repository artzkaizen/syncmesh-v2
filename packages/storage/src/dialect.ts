import type { CellValue } from "@syncmesh/kernel";
import type { ColumnKind } from "@syncmesh/schema";

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

export interface Dialect {
  readonly name: SqlDialect;
  readonly events: EventSql;
  readonly state: StateSql;
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

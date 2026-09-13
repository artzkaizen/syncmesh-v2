import type { RowWrite } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";

import type { SqlDriver } from "./driver.js";

import { dialectOf } from "./dialect.js";

/**
 * Where each row's own write got to, as a table a query can join (book ch. 10).
 *
 * The earlier shape was `useSyncOf("products", row.id)` — a string table name correlated by hand
 * against rows that came out of a handwritten query. That cannot work: queries are the app's own
 * Drizzle, with joins and projections and renames, so the framework does not know which table a
 * row "is", and asking the developer to restate it as a string is the bug rather than the fix.
 * The place that already names the table, typed, is the query. So this is what the query joins.
 *
 * Two tables, because the two facts change at different times. `_syncmesh_row_sync` changes when
 * a row is folded — the winning write's author and stamp — and `_syncmesh_acked` changes when a
 * peer acknowledges, which touches no row at all. Keeping the watermark out of the row means an
 * acknowledgement is one update rather than one per row it settles.
 */

export const ROW_SYNC = "_syncmesh_row_sync";
export const ACKED = "_syncmesh_acked";

export const rowSyncDdl: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${ROW_SYNC} (
    tbl TEXT NOT NULL,
    key TEXT NOT NULL,
    peer TEXT NOT NULL,
    hlc_ms BIGINT NOT NULL,
    hlc_logical INTEGER NOT NULL,
    PRIMARY KEY (tbl, key)
  )`,
  // one row, or none: the highest stamp of this device's own writes any peer has acknowledged
  `CREATE TABLE IF NOT EXISTS ${ACKED} (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    hlc_ms BIGINT NOT NULL,
    hlc_logical INTEGER NOT NULL
  )`,
];

/** Keeps {@link ROW_SYNC} in step with the fold, inside the same commit the rows land in. */
export interface RowSync {
  readonly apply: (rows: readonly RowWrite[]) => Promise<void>;
  /** Moves the watermark; what an acknowledgement does, once, however many rows it settles. */
  readonly acknowledge: (hlcMs: number, hlcLogical: number) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export function rowSyncTable(driver: SqlDriver): RowSync {
  const mark = dialectOf(driver).placeholder;
  const marks = (n: number) => Array.from({ length: n }, (_, i) => mark(i + 1)).join(", ");
  const upsert = `INSERT INTO ${ROW_SYNC} (tbl, key, peer, hlc_ms, hlc_logical) VALUES (${marks(5)})
    ON CONFLICT(tbl, key) DO UPDATE SET peer = excluded.peer, hlc_ms = excluded.hlc_ms, hlc_logical = excluded.hlc_logical`;
  const remove = `DELETE FROM ${ROW_SYNC} WHERE tbl = ${mark(1)} AND key = ${mark(2)}`;
  const watermark = `INSERT INTO ${ACKED} (id, hlc_ms, hlc_logical) VALUES (0, ${mark(1)}, ${mark(2)})
    ON CONFLICT(id) DO UPDATE SET hlc_ms = excluded.hlc_ms, hlc_logical = excluded.hlc_logical`;

  return {
    apply: async (rows) => {
      for (const { table, key, record } of rows) {
        const stamp = record.writeStamp;
        // a row with no write stamp was never written through an event — nothing to say about it
        if (stamp === undefined) {
          await driver.run(remove, [String(table), String(key)]);
          continue;
        }
        await driver.run(upsert, [
          String(table),
          String(key),
          String(stamp.peer),
          stamp.hlc[0].epochMilliseconds,
          stamp.hlc[1],
        ]);
      }
    },
    acknowledge: (hlcMs, hlcLogical) => driver.run(watermark, [hlcMs, hlcLogical]),
    clear: async () => {
      await driver.run(`DELETE FROM ${ROW_SYNC}`);
      await driver.run(`DELETE FROM ${ACKED}`);
    },
  };
}

/**
 * The `CASE` a `syncOf(table)` select compiles to, as text: another peer wrote it, or this
 * device did and the watermark has passed it, or it is still only here.
 *
 * Correlated on the row's own primary key, so it reads as one column of the row it belongs to
 * and needs no join the app has to remember to write. The watermark is read from its table
 * rather than bound, because an acknowledgement must change the answer of a query that was
 * built minutes ago — a bound value would be the reading taken when the query was written.
 *
 * Compared field by field rather than as a row value: both dialects support row comparison, but
 * spelling it out is one fewer thing that has to be true of a driver somebody writes later. An
 * empty watermark makes the `EXISTS` false, which reads as `local` — correct, because nothing
 * has been acknowledged yet.
 */
/** A SQL string literal: the only two values interpolated here are a peer id and a table name. */
const quoted = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * The pending operation id for a row, as text — the join key into `$operations` (book ch. 10).
 *
 * Keyed on the stamp both tables already carry, so nothing new is written to make the join
 * possible. There is deliberately no `correctionOf` beside it: a correction's *why* matters to
 * the author of the displaced write and lives on their operation record; to a reader who never
 * wrote the old value, the corrected value is simply the value.
 */
export const operationOfSql = (table: string, keyColumn: string, operations: string): string =>
  `(SELECT o.id FROM ${ROW_SYNC} rs
      JOIN ${operations} o
        ON o.peer = rs.peer AND o.hlc_ms = rs.hlc_ms AND o.hlc_logical = rs.hlc_logical
    WHERE rs.tbl = ${quoted(table)} AND rs.key = ${keyColumn})`;

export const syncOfSql = (self: PeerId, table: string, keyColumn: string): string =>
  `(SELECT CASE
      WHEN rs.peer <> ${quoted(String(self))} THEN 'remote'
      WHEN EXISTS (
        SELECT 1 FROM ${ACKED} a
        WHERE a.hlc_ms > rs.hlc_ms OR (a.hlc_ms = rs.hlc_ms AND a.hlc_logical >= rs.hlc_logical)
      ) THEN 'delivered'
      ELSE 'local' END
    FROM ${ROW_SYNC} rs WHERE rs.tbl = ${quoted(table)} AND rs.key = ${keyColumn})`;

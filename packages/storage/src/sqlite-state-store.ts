import type { StateStore } from "@syncmesh/engine";
import type { RowKey, RowRecord, State, TableName } from "@syncmesh/kernel";

import { StateCorrupt, type StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";

import type { Projection } from "./capture.js";
import type { SqlRow, SqlValue, SqliteDriver } from "./driver.js";

import { decodeRecord, encodeRecord } from "./record-codec.js";
import { migrate } from "./schema.js";
import { attempt, coverageOf, inTransaction } from "./sql.js";

const UPSERT_ROW = `INSERT OR REPLACE INTO state_rows (tbl, key, record) VALUES (?, ?, ?)`;
const UPSERT_CURSOR = `INSERT OR REPLACE INTO state_cursors (peer, local, seq) VALUES (?, ?, ?)`;
const SELECT_ROWS = `SELECT tbl, key, record FROM state_rows`;
const SELECT_CURSORS = `SELECT peer, local, seq FROM state_cursors`;
const ANY_CURSOR = `SELECT 1 FROM state_cursors LIMIT 1`;

const corrupt = (message: string) => new StateCorrupt({ message });

function decodeRow(row: SqlRow): Result<readonly [TableName, RowKey, RowRecord], StateCorrupt> {
  const [table, key, record] = row;
  if (!(record instanceof Uint8Array)) return Result.err(corrupt("record is not a blob"));
  return decodeRecord(record)
    .mapError((e) => corrupt(e.message))
    .map((decoded) => {
      // SAFETY: these columns were written from a TableName and a RowKey by commit(); the record's decode is the check that the row is intact
      return [String(table) as TableName, String(key) as RowKey, decoded] as const;
    });
}

export interface SqliteStateStoreOptions {
  /** Also writes each committed row into the app's own tables (D20); `tablesProjection` builds one. */
  readonly projection?: Projection;
}

/**
 * Opens the persisted state in the database behind `driver`; shares the file with `sqliteEventStore`.
 * Records with their stamps live in `state_rows`; with a projection, the values also land in the
 * app's tables in the same transaction.
 *
 * @example
 * const driver = bunSqliteDriver("app.db");
 * const stateStore = (await sqliteStateStore(driver)).unwrap();
 */
export function sqliteStateStore(
  driver: SqliteDriver,
  options: SqliteStateStoreOptions = {},
): Promise<Result<StateStore, StoreFailure>> {
  const { projection } = options;
  const query = (message: string, sql: string, values: readonly SqlValue[] = []) =>
    attempt(message, () => driver.all(sql, values));

  const store: StateStore = {
    isEmpty: () =>
      query("isEmpty failed", ANY_CURSOR).then((r) => r.map((rows) => rows.length === 0)),
    loadAll: () =>
      Result.gen(async function* () {
        const rows = yield* Result.await(query("loadAll failed", SELECT_ROWS));
        const state = new Map<TableName, Map<RowKey, RowRecord>>();
        for (const row of rows) {
          const [table, key, record] = yield* decodeRow(row);
          const records = state.get(table) ?? new Map<RowKey, RowRecord>();
          records.set(key, record);
          state.set(table, records);
        }
        return Result.ok<State>(state);
      }),
    loadCursors: () =>
      query("loadCursors failed", SELECT_CURSORS).then((rows) => rows.andThen(coverageOf)),
    commit: (rows, coverage) =>
      attempt("commit failed", () =>
        inTransaction(driver, async () => {
          for (const { table, key, record } of rows)
            await driver.run(UPSERT_ROW, [table, key, encodeRecord(record)]);
          for (const [peer, seq] of coverage.synced)
            await driver.run(UPSERT_CURSOR, [peer, 0, seq]);
          for (const [peer, seq] of coverage.local) await driver.run(UPSERT_CURSOR, [peer, 1, seq]);
          await projection?.apply(rows);
        }),
      ),
    clear: () =>
      attempt("clear failed", () =>
        inTransaction(driver, async () => {
          await driver.run("DELETE FROM state_rows");
          await driver.run("DELETE FROM state_cursors");
          await projection?.clear();
        }),
      ),
  };

  return attempt("open failed", () => migrate(driver)).then((opened) => opened.map(() => store));
}

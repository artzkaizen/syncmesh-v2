import type { StateStore } from "@syncmesh/engine";
import type { RowKey, RowRecord, State, TableName } from "@syncmesh/kernel";

import { StateCorrupt, type StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";

import type { SqlDriver, SqlRow, SqlValue } from "./driver.js";
import type { Projection } from "./projection.js";

import { dialectOf } from "./dialect.js";
import { decodeRecord, encodeRecord } from "./record-codec.js";
import { attempt, coverageOf, inTransaction } from "./sql.js";

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

export interface SqlStateStoreOptions {
  /** Also writes each committed row into the app's own tables (D20); `tablesProjection` builds one. */
  readonly projection?: Projection;
}

/**
 * Opens the persisted state in the database behind `driver`; shares it with `sqlEventStore`.
 * Records with their stamps live in the sidecar; with a projection, the values also land in the
 * app's tables in the same transaction.
 *
 * @example
 * const driver = bunSqlDriver("app.db");
 * const stateStore = (await sqlStateStore(driver)).unwrap();
 */
export function sqlStateStore(
  driver: SqlDriver,
  options: SqlStateStoreOptions = {},
): Promise<Result<StateStore, StoreFailure>> {
  const { projection } = options;
  const { state: SQL, migrate } = dialectOf(driver);
  const query = (message: string, sql: string, values: readonly SqlValue[] = []) =>
    attempt(message, () => driver.all(sql, values));

  const store: StateStore = {
    isEmpty: () =>
      query("isEmpty failed", SQL.anyCursor).then((r) => r.map((rows) => rows.length === 0)),
    loadAll: () =>
      Result.gen(async function* () {
        const rows = yield* Result.await(query("loadAll failed", SQL.selectRows));
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
      query("loadCursors failed", SQL.selectCursors).then((rows) => rows.andThen(coverageOf)),
    commit: (rows, coverage) =>
      attempt("commit failed", () =>
        inTransaction(driver, async () => {
          for (const { table, key, record } of rows)
            await driver.run(SQL.upsertRow, [table, key, encodeRecord(record)]);
          for (const [peer, seq] of coverage.synced)
            await driver.run(SQL.upsertCursor, [peer, 0, seq]);
          for (const [peer, seq] of coverage.local)
            await driver.run(SQL.upsertCursor, [peer, 1, seq]);
          await projection?.apply(rows);
        }),
      ),
    clear: () =>
      attempt("clear failed", () =>
        inTransaction(driver, async () => {
          await driver.run(SQL.clearRows);
          await driver.run(SQL.clearCursors);
          await projection?.clear();
        }),
      ),
  };

  return attempt("open failed", () => migrate(driver)).then((opened) => opened.map(() => store));
}

/** `sqlStateStore` under its SQLite-era name; the store speaks whatever dialect the driver has. */
export const sqliteStateStore = sqlStateStore;
export type SqliteStateStoreOptions = SqlStateStoreOptions;

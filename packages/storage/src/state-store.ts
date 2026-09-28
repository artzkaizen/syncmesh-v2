import type { Coverage, StateStore } from "@syncmesh/engine";
import type { RowKey, State, TableName, TableState } from "@syncmesh/kernel";

import { StateCorrupt, type StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { decodeRecord, encodeRecord } from "@syncmesh/wire";

import type { SqlDriver, SqlRow, SqlValue } from "./driver.js";
import type { Projection } from "./projection.js";

import { dialectOf } from "./dialect.js";
import { lazyTable } from "./lazy-state.js";
import { attempt, coverageOf, inTransaction, scopeOf } from "./sql.js";

const corrupt = (message: string) => new StateCorrupt({ message });

/**
 * Where a stored row belongs and the bytes it holds, without reading inside them.
 *
 * The blob check stays eager because it is free and catches the shape of damage a migration or a
 * hand-edited database produces; what the bytes *contain* is checked when they are decoded, which
 * is now the first time the row is wanted rather than the moment the database opens.
 */
function addressOf(row: SqlRow): Result<readonly [TableName, RowKey, Uint8Array], StateCorrupt> {
  const [table, key, record] = row;
  if (!(record instanceof Uint8Array)) return Result.err(corrupt("record is not a blob"));
  // SAFETY: these columns were written from a TableName and a RowKey by commit()
  return Result.ok([String(table) as TableName, String(key) as RowKey, record] as const);
}

/**
 * One row of a table, decoded on the spot, so a cache the build can no longer read is found here.
 *
 * The rest of the cache is decoded lazily ({@link lazyTable}), which on its own would move the
 * discovery of a damaged cache to whenever a row was first touched — and the engine's answer to a
 * damaged cache is to clear it and rebuild from the log, which it can only do while it is still
 * opening. The realistic damage is not one rotted row but a *format* the running build no longer
 * reads, after an upgrade or a schema change, and that shows in the first row as surely as in all
 * of them. So one per table is decoded and thrown away: enough to keep the rebuild reachable, at a
 * cost that does not grow with the data. A single damaged row among sound ones is still found, but
 * when it is read rather than when the database opens.
 */
function firstDecodes(records: ReadonlyMap<RowKey, Uint8Array>): Result<void, StateCorrupt> {
  for (const record of records.values())
    return decodeRecord(record)
      .mapError((e) => corrupt(e.message))
      .map(() => undefined);
  return Result.ok(undefined);
}

export interface SqlStateStoreOptions {
  /** Also writes each committed row into the app's own tables (D20); `tablesProjection` builds one. */
  readonly projection?: Projection;
  /** The caller holds the transaction; see `SqlEventStoreOptions.nested`. */
  readonly nested?: boolean;
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
  const transaction = <T>(fn: () => Promise<T>): Promise<T> =>
    options.nested === true ? fn() : inTransaction(driver, fn);
  const query = (message: string, sql: string, values: readonly SqlValue[] = []) =>
    attempt(message, () => driver.all(sql, values));

  const store: StateStore = {
    isEmpty: () =>
      query("isEmpty failed", SQL.anyCursor).then((r) => r.map((rows) => rows.length === 0)),
    loadAll: () =>
      Result.gen(async function* () {
        const rows = yield* Result.await(query("loadAll failed", SQL.selectRows));
        const stored = new Map<TableName, Map<RowKey, Uint8Array>>();
        for (const row of rows) {
          const [table, key, record] = yield* addressOf(row);
          const records = stored.get(table) ?? new Map<RowKey, Uint8Array>();
          records.set(key, record);
          stored.set(table, records);
        }
        // the blobs go in undecoded: see `lazyTable` for why, and for the one caller that
        // deliberately decodes a whole table
        const state = new Map<TableName, TableState>();
        for (const [table, records] of stored) {
          yield* firstDecodes(records);
          state.set(table, lazyTable(records));
        }
        return Result.ok<State>(state);
      }),
    loadCursors: () =>
      Result.gen(async function* () {
        const rows = yield* Result.await(query("loadCursors failed", SQL.selectCursors));
        const coverage = yield* coverageOf(rows);
        const scoped = yield* Result.await(query("loadScope failed", SQL.selectScope));
        const scope = scopeOf(scoped);
        // the numbers and the interest that makes them true load together or the cursor is a lie
        return Result.ok<Coverage>(scope === undefined ? coverage : { ...coverage, scope });
      }),
    commit: (rows, coverage) =>
      attempt("commit failed", () =>
        transaction(async () => {
          for (const { table, key, record } of rows)
            await driver.run(SQL.upsertRow, [table, key, encodeRecord(record)]);
          for (const [peer, seq] of coverage.synced)
            await driver.run(SQL.upsertCursor, [peer, 0, seq]);
          for (const [peer, seq] of coverage.local)
            await driver.run(SQL.upsertCursor, [peer, 1, seq]);
          // in the same transaction as the numbers: a scope that survived a commit the cursors
          // did not, or the other way round, is exactly the mismatch D23 exists to prevent
          if (coverage.scope === undefined) await driver.run(SQL.clearScope);
          else await driver.run(SQL.upsertScope, [coverage.scope]);
          await projection?.apply(rows);
        }),
      ),
    clear: () =>
      attempt("clear failed", () =>
        transaction(async () => {
          await driver.run(SQL.clearRows);
          await driver.run(SQL.clearCursors);
          await driver.run(SQL.clearScope);
          await projection?.clear();
        }),
      ),
  };

  if (options.nested === true) return Promise.resolve(Result.ok(store)); // the owner migrated
  return attempt("open failed", () => migrate(driver)).then((opened) => opened.map(() => store));
}

/** `sqlStateStore` under its SQLite-era name; the store speaks whatever dialect the driver has. */
export const sqliteStateStore = sqlStateStore;
export type SqliteStateStoreOptions = SqlStateStoreOptions;

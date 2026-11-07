import type {
  OpenStoresOptions,
  SqlRow,
  SqliteDriver,
  StoreLocked,
  Stores,
} from "@syncmesh/storage";

import { StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import {
  ATTACHED_LOG,
  acquireStoreLock,
  lockPathFor,
  openStores,
  schemaNameFor,
  sqliteDriver,
  statePathFor,
} from "@syncmesh/storage";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Opens the store at `logPath` with `bun:sqlite` as a driver for `@syncmesh/storage`. Sets WAL and
 * `synchronous = NORMAL` (RFC-0004).
 *
 * **A store is two files, and this opens both** (RFC-0022). The name you give is the **log's** —
 * the durable half, attached as `syncmesh`. The derived half hangs off it under a name carrying
 * `schema`, and is opened as `main`: it holds the app's own tables and the projection, and is the
 * one that can be deleted and refolded. The adapter opens the pair rather than the caller because
 * the adapter is what knows the paths, and a connection without the attach resolves none of the
 * log's tables.
 *
 * @param logPath A file path, or `":memory:"` for a store that lives as long as the driver — in
 * which case the derived half is a second, private in-memory database and the pair is ephemeral
 * together.
 * @param schema Names the derived half; pass `schemaNameFor(tables)` so that changing a column
 * opens an empty file to refold into rather than the previous shape's rows.
 *
 * @example
 * const store = (await sqliteEventStore(bunSqliteDriver("app.db"))).unwrap();
 */
export function bunSqliteDriver(logPath: string, schema = schemaNameFor([])): SqliteDriver {
  const memory = logPath === ":memory:";
  const db = new Database(memory ? ":memory:" : statePathFor(logPath, schema), {
    create: true,
    strict: true,
  });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run(`ATTACH DATABASE ? AS ${ATTACHED_LOG}`, [memory ? ":memory:" : logPath]);

  return sqliteDriver({
    exec: (sql) => db.run(sql),
    run: (sql, params) => void db.run(sql, [...params]),
    // SAFETY: SQLite hands back text, integers (number or bigint), reals, blobs and NULL — exactly SqlValue
    all: (sql, params) => db.query(sql).values(...params) as readonly SqlRow[],
    close: () => db.close(),
  });
}

export interface DefaultStoreOptions extends OpenStoresOptions {
  /** The store's name; `<dir>/<name>.db` is the log, and the rest of its files hang off that. */
  readonly name: string;
  readonly dir: string;
}

/**
 * The durable default on Bun: the event log at `<dir>/<name>.db` with the folded state beside it,
 * the directory created if missing, both held under one exclusive lock — a second open fails now with `StoreLocked`,
 * and `close` releases the hold.
 *
 * @example
 * const stores = (await defaultStore({ name: "notes", dir: ".syncmesh" })).unwrap();
 */
export async function defaultStore(
  options: DefaultStoreOptions,
): Promise<Result<Stores, StoreFailure | StoreLocked>> {
  mkdirSync(options.dir, { recursive: true });
  const logPath = join(options.dir, `${options.name}.db`);
  const lockDb = new Database(lockPathFor(logPath), { create: true, strict: true });
  // over the store, not the file: every file named after `logPath` is held and released together
  const lock = acquireStoreLock({
    path: logPath,
    run: (sql) => lockDb.run(sql),
    close: () => lockDb.close(),
  });
  if (lock.isErr()) return lock;
  // the app's schema names the derived half, so a changed column refolds instead of migrating
  // a file that is not a database throws from the driver's own constructor — before any store
  // has a Result to carry it — and a damaged log has to be refused as a value, never a throw
  const driver = Result.try({
    try: () => bunSqliteDriver(logPath, schemaNameFor(options.tables ?? [])),
    catch: (cause) =>
      new StoreFailure({ message: `the store at ${logPath} would not open`, cause }),
  });
  if (driver.isErr()) {
    lock.value.release();
    return driver;
  }
  const stores = await openStores(driver.value, options);
  if (stores.isErr()) {
    lock.value.release();
    return stores;
  }
  const opened = stores.value;
  return stores.map(() => ({
    ...opened,
    close: async () => {
      await opened.close();
      lock.value.release();
    },
  }));
}

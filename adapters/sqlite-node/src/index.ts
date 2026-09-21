import type { StoreFailure } from "@syncmesh/engine";
import type { Result } from "@syncmesh/result";
import type {
  OpenStoresOptions,
  SqlRow,
  SqliteDriver,
  StoreLocked,
  Stores,
} from "@syncmesh/storage";

import {
  ATTACHED_LOG,
  acquireStoreLock,
  lockPathFor,
  logPathFor,
  openStores,
  sqliteDriver,
} from "@syncmesh/storage";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Opens `path` with `node:sqlite` as a driver for `@syncmesh/storage`. Sets WAL and `synchronous = NORMAL` (RFC-0004).
 *
 * @param path A file path, or `":memory:"` for a database that lives as long as the driver.
 */
export function nodeSqliteDriver(path: string): SqliteDriver {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // a store is two files: this one holds the app's tables and the projection, and the durable log
  // is attached beside it as `syncmesh` (RFC-0022)
  db.prepare(`ATTACH DATABASE ? AS ${ATTACHED_LOG}`).run(
    path === ":memory:" ? ":memory:" : logPathFor(path),
  );

  return sqliteDriver({
    exec: (sql) => db.exec(sql),
    run: (sql, params) => void db.prepare(sql).run(...params),
    all: (sql, params) =>
      db
        .prepare(sql)
        .all(...params)
        .map((row) => {
          // SAFETY: node:sqlite returns one object per row keyed by column name in SELECT order; its values are text, integers, reals, blobs or NULL — SqlValue
          return Object.values(row) as SqlRow;
        }),
    close: () => db.close(),
  });
}

export interface DefaultStoreOptions extends OpenStoresOptions {
  /** Database name; `<dir>/<name>.db` on disk. */
  readonly name: string;
  readonly dir: string;
}

/**
 * The durable default on Node: event log and persisted state in one SQLite file, the directory
 * created if missing, held under an exclusive lock — a second open fails now with `StoreLocked`,
 * and `close` releases the hold.
 *
 * @example
 * const stores = (await defaultStore({ name: "notes", dir: ".syncmesh" })).unwrap();
 */
export async function defaultStore(
  options: DefaultStoreOptions,
): Promise<Result<Stores, StoreFailure | StoreLocked>> {
  mkdirSync(options.dir, { recursive: true });
  const path = join(options.dir, `${options.name}.db`);
  const lockDb = new DatabaseSync(lockPathFor(path));
  // over the store, not the file: `path` and its log are opened and forgotten together
  const lock = acquireStoreLock({
    path,
    run: (sql) => lockDb.exec(sql),
    close: () => lockDb.close(),
  });
  if (lock.isErr()) return lock;
  // the state file is `main`; the log is attached beside it, and the lock above covers both
  const driver = nodeSqliteDriver(path);
  const stores = await openStores(driver, options);
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

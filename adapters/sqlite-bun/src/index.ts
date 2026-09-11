import type { StoreFailure } from "@syncmesh/engine";
import type { Result } from "@syncmesh/result";
import type {
  OpenStoresOptions,
  SqlRow,
  SqliteDriver,
  StoreLocked,
  Stores,
} from "@syncmesh/storage";

import { acquireStoreLock, openStores, sqliteDriver } from "@syncmesh/storage";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Opens `path` with `bun:sqlite` as a driver for `@syncmesh/storage`. Sets WAL and `synchronous = NORMAL` (RFC-0004).
 *
 * @param path A file path, or `":memory:"` for a database that lives as long as the driver.
 *
 * @example
 * const store = (await sqliteEventStore(bunSqliteDriver("app.db"))).unwrap();
 */
export function bunSqliteDriver(path: string): SqliteDriver {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");

  return sqliteDriver({
    exec: (sql) => db.run(sql),
    run: (sql, params) => void db.run(sql, [...params]),
    // SAFETY: SQLite hands back text, integers (number or bigint), reals, blobs and NULL — exactly SqlValue
    all: (sql, params) => db.query(sql).values(...params) as readonly SqlRow[],
    close: () => db.close(),
  });
}

export interface DefaultStoreOptions extends OpenStoresOptions {
  /** Database name; `<dir>/<name>.db` on disk. */
  readonly name: string;
  readonly dir: string;
}

/**
 * The durable default on Bun: event log and persisted state in one SQLite file, the directory
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
  const lockDb = new Database(`${path}.lock`, { create: true, strict: true });
  const lock = acquireStoreLock({
    path,
    run: (sql) => lockDb.run(sql),
    close: () => lockDb.close(),
  });
  if (lock.isErr()) return lock;
  const stores = await openStores(bunSqliteDriver(path), options);
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

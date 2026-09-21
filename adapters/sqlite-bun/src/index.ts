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
  logPathFor,
  openStores,
  sqliteDriver,
} from "@syncmesh/storage";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Opens `path` with `bun:sqlite` as a driver for `@syncmesh/storage`. Sets WAL and `synchronous = NORMAL` (RFC-0004).
 *
 * **A store is two files, and this opens both** (RFC-0022): `path` is the derived half and holds
 * the app's own tables and the projection; the durable log is attached beside it as `syncmesh`.
 * The adapter does it rather than the caller because the adapter is what knows the paths, and a
 * connection without it resolves none of the log's tables.
 *
 * @param path A file path, or `":memory:"` for a database that lives as long as the driver — in
 * which case the log is a second, private in-memory database and the pair is ephemeral together.
 *
 * @example
 * const store = (await sqliteEventStore(bunSqliteDriver("app.db"))).unwrap();
 */
export function bunSqliteDriver(path: string): SqliteDriver {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run(`ATTACH DATABASE ? AS ${ATTACHED_LOG}`, [
    path === ":memory:" ? ":memory:" : logPathFor(path),
  ]);

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
  // the state file is `main`; the log is attached beside it, and the lock above covers both
  const driver = bunSqliteDriver(path);
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

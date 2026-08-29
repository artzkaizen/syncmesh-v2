import type { StoreFailure } from "@syncmesh/engine";
import type { Result } from "@syncmesh/result";
import type { OpenStoresOptions, SqlRow, SqliteDriver, Stores } from "@syncmesh/storage";

import { openStores, sqliteDriver } from "@syncmesh/storage";
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
 * The durable default on Node: event log and persisted state in one SQLite file, the directory created if missing.
 *
 * @example
 * const stores = (await defaultStore({ name: "notes", dir: ".syncmesh" })).unwrap();
 */
export function defaultStore(options: DefaultStoreOptions): Promise<Result<Stores, StoreFailure>> {
  mkdirSync(options.dir, { recursive: true });
  return openStores(nodeSqliteDriver(join(options.dir, `${options.name}.db`)), options);
}

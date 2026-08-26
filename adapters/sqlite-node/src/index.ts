import type { StoreFailure } from "@syncmesh/engine";
import type { Result } from "@syncmesh/result";
import type { OpenStoresOptions, SqlRow, SqliteDriver, Stores, SqlValue } from "@syncmesh/storage";

import { openStores } from "@syncmesh/storage";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Opens `path` with `node:sqlite` as a driver for `@syncmesh/storage`. Sets WAL and `synchronous = NORMAL` (RFC-0004).
 *
 * @param path A file path, or `":memory:"` for a database that lives as long as the driver.
 */
/** SQLite has no boolean or date: they bind as the integers the SQLite dialect writes. */
const bind = (params: readonly SqlValue[]) =>
  params.map((p) => (p === true ? 1 : p === false ? 0 : p instanceof Date ? p.getTime() : p));

export function nodeSqliteDriver(path: string): SqliteDriver {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  return {
    dialect: "sqlite",
    run: (sql, params = []) => {
      db.prepare(sql).run(...bind(params));
      return Promise.resolve();
    },
    all: (sql, params = []) => {
      // SAFETY: node:sqlite returns one object per row keyed by column name in SELECT order; its values are text, integers, reals, blobs or NULL — SqlValue
      const rows = db
        .prepare(sql)
        .all(...bind(params))
        .map((row) => Object.values(row) as SqlRow);
      return Promise.resolve(rows);
    },
    transaction: async (fn) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        db.exec("COMMIT");
        return result;
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    },
    close: () => {
      db.close();
      return Promise.resolve();
    },
  };
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

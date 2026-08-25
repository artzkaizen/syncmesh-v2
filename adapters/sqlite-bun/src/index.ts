import type { StoreFailure } from "@syncmesh/engine";
import type { Result } from "@syncmesh/result";
import type { SqlRow, SqliteDriver, Stores } from "@syncmesh/storage";

import { openStores } from "@syncmesh/storage";
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

  return {
    run: (sql, params = []) => {
      db.run(sql, [...params]);
      return Promise.resolve();
    },
    all: (sql, params = []) => {
      // SAFETY: SQLite hands back text, integers (number or bigint), reals, blobs and NULL — exactly SqlValue
      const rows = db.query(sql).values(...params) as readonly SqlRow[];
      return Promise.resolve(rows);
    },
    transaction: async (fn) => {
      db.run("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        db.run("COMMIT");
        return result;
      } catch (cause) {
        db.run("ROLLBACK");
        throw cause;
      }
    },
    close: () => {
      db.close();
      return Promise.resolve();
    },
  };
}

export interface DefaultStoreOptions {
  /** Database name; `<dir>/<name>.db` on disk. */
  readonly name: string;
  readonly dir: string;
}

/**
 * The durable default on Bun: event log and persisted state in one SQLite file, the directory created if missing.
 *
 * @example
 * const stores = (await defaultStore({ name: "notes", dir: ".syncmesh" })).unwrap();
 */
export function defaultStore(options: DefaultStoreOptions): Promise<Result<Stores, StoreFailure>> {
  mkdirSync(options.dir, { recursive: true });
  return openStores(bunSqliteDriver(join(options.dir, `${options.name}.db`)));
}

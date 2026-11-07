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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Opens the store at `logPath` with `node:sqlite` as a driver for `@syncmesh/storage`. Sets WAL and
 * `synchronous = NORMAL` (RFC-0004).
 *
 * @param logPath The **log's** path — the durable half, attached as `syncmesh`. The derived half
 * hangs off it under a name carrying `schema` and is opened as `main` (RFC-0022). `":memory:"`
 * gives a pair that lives as long as the driver.
 * @param schema Names the derived half; pass `schemaNameFor(tables)` so that changing a column
 * opens an empty file to refold into rather than the previous shape's rows.
 */
export function nodeSqliteDriver(logPath: string, schema = schemaNameFor([])): SqliteDriver {
  const memory = logPath === ":memory:";
  const db = new DatabaseSync(memory ? ":memory:" : statePathFor(logPath, schema));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.prepare(`ATTACH DATABASE ? AS ${ATTACHED_LOG}`).run(memory ? ":memory:" : logPath);

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
  /** The store's name; `<dir>/<name>.db` is the log, and the rest of its files hang off that. */
  readonly name: string;
  readonly dir: string;
}

/**
 * The durable default on Node: the event log at `<dir>/<name>.db` with the folded state beside it,
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
  const lockDb = new DatabaseSync(lockPathFor(logPath));
  // over the store, not the file: every file named after `logPath` is held and released together
  const lock = acquireStoreLock({
    path: logPath,
    run: (sql) => lockDb.exec(sql),
    close: () => lockDb.close(),
  });
  if (lock.isErr()) return lock;
  // the app's schema names the derived half, so a changed column refolds instead of migrating
  // a file that is not a database throws from the driver's own constructor — before any store
  // has a Result to carry it — and a damaged log has to be refused as a value, never a throw
  const driver = Result.try({
    try: () => nodeSqliteDriver(logPath, schemaNameFor(options.tables ?? [])),
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

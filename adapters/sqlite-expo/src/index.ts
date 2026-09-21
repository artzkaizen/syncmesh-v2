import type { StoreFailure } from "@syncmesh/engine";
import type { Result } from "@syncmesh/result";
import type { OpenStoresOptions, SqliteDriver, StoreLocked, Stores } from "@syncmesh/storage";

import { acquireStoreLock, attachLog, logPathFor, openStores } from "@syncmesh/storage";
import { openDatabaseSync } from "expo-sqlite";

import type { ExpoDatabase } from "./driver.js";

import { expoSqliteDriverOver } from "./driver.js";

export type { ExpoDatabase, SqlTrace } from "./driver.js";
export { expoSqliteDriverOver, traceStatements } from "./driver.js";

/**
 * Opens `name` with `expo-sqlite` as a driver for `@syncmesh/storage`. Sets WAL and
 * `synchronous = NORMAL` (RFC-0004), exactly as the Bun and Node adapters do.
 *
 * The database lives in the app's own documents directory, which is what makes a phone a peer
 * rather than a viewer: the log is on the device, the rows are folded from it locally, and a
 * `SELECT` answers with the aeroplane in flight (book ch. 3).
 *
 * @param name A database name — `expo-sqlite` resolves it under the app's sandbox — or
 *   `":memory:"` for one that lives as long as the driver.
 *
 * @example
 * const client = createClient({ schema, procedures, storage: sqlite({ driver: expoSqliteDriver("issues.db") }) });
 */
export function expoSqliteDriver(name: string): SqliteDriver {
  const db: ExpoDatabase = openDatabaseSync(name);
  db.execSync("PRAGMA journal_mode = WAL");
  db.execSync("PRAGMA synchronous = NORMAL");
  return expoSqliteDriverOver(db);
}

export interface DefaultStoreOptions extends OpenStoresOptions {
  /** Database name; `<name>.db` inside the app's own sandbox. */
  readonly name: string;
}

/**
 * The durable default on a phone: event log and folded state in one SQLite file, held under an
 * exclusive lock.
 *
 * The lock matters less here than on a desktop — an app is one process — and it is kept anyway,
 * because the failure it prevents is the same one everywhere: two engines over one log stamp
 * events below ones peers have already seen and lose them silently. A second open fails now with
 * `StoreLocked`, and `close` releases the hold.
 *
 * @example
 * const stores = (await defaultStore({ name: "issues" })).unwrap();
 */
export async function defaultStore(
  options: DefaultStoreOptions,
): Promise<Result<Stores, StoreFailure | StoreLocked>> {
  const path = `${options.name}.db`;
  const lockDb: ExpoDatabase = openDatabaseSync(`${path}.lock`);
  const lock = acquireStoreLock({
    path,
    run: (sql) => lockDb.execSync(sql),
    close: () => lockDb.closeSync(),
  });
  if (lock.isErr()) return lock;
  // the state file is `main`; the log is attached beside it, and the lock above covers both
  const driver = expoSqliteDriver(path);
  await attachLog(driver, logPathFor(path));
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

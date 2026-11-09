import type { SqlRow, SqliteDriver } from "@syncmesh/storage";

import { attachLog, statePath } from "@syncmesh/storage";
import { Database } from "bun:sqlite";

import type { ExpoBindValue, ExpoDatabase } from "../driver.js";

import { expoSqliteDriverOver } from "../driver.js";

/**
 * `expo-sqlite`'s four calls, over `bun:sqlite`.
 *
 * A phone is not available to a test runner, and the thing that could actually be wrong here is
 * not the phone: it is the shape of a row. `expo-sqlite` answers a query with **an object per
 * row** where every other binding in this repo answers with positional values, and the store
 * contract is written in positional values — so the adapter converts, and this is the suite that
 * says the conversion holds for blobs, nulls, bigints and the rest. `bun:sqlite`'s `.all()`
 * returns objects keyed by column in `SELECT` order, which is the same shape Expo returns for the
 * same reason, so the fake differs from the real binding in where it runs and nowhere else.
 */
export const fakeExpo = (path: string) => {
  const db = new Database(path, { create: true, strict: true });
  return {
    closeSync: () => db.close(),
    execSync: (sql: string) => db.run(sql),
    prepareSync: (sql: string) => ({
      // SAFETY: `.values()` is `bun:sqlite`'s positional answer — one array per row holding the
      // values the statement named, in the order it named them, which is exactly what
      // `executeForRawResultSync` returns on a device and exactly what `SqlRow` is
      executeForRawResultSync: (params: ExpoBindValue[]) => ({
        getAllSync: () => db.query(sql).values(...params) as readonly SqlRow[],
      }),
      finalizeSync: () => undefined,
    }),
    runSync: (sql: string, params: ExpoBindValue[]) => db.run(sql, [...params]),
  } satisfies ExpoDatabase;
};

/**
 * The store at `logPath` as `defaultStore` opens it on a phone, over {@link fakeExpo} files: the
 * derived half named after `schema` with WAL and `synchronous = NORMAL` set as
 * `expoSqliteDriver` sets them, and the log attached beside it. What the crash and torn suites
 * kill and tear.
 */
export async function expoFileDriver(logPath: string, schema: string): Promise<SqliteDriver> {
  const db = fakeExpo(statePath(logPath, schema));
  db.execSync("PRAGMA journal_mode = WAL");
  db.execSync("PRAGMA synchronous = NORMAL");
  const driver = expoSqliteDriverOver(db);
  await attachLog(driver, logPath);
  return driver;
}

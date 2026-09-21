import { Database } from "bun:sqlite";

import type { SqlRow, SqliteDriver } from "../driver.js";

import { attachLog } from "../open-stores.js";
import { sqliteDriver } from "../sqlite-driver.js";

/**
 * A connection over both halves: the derived one as `main`, the log attached as `syncmesh`.
 *
 * Every test that touches an engine table needs the pair, because the log's tables are written
 * against the attached name (RFC-0022) and a connection without it resolves none of them. One
 * helper rather than the same four lines in six files, which is how those six copies started.
 *
 * Here rather than in `driver-tests/`, which is the suite every adapter runs and may not import
 * `bun:sqlite` — this is storage's own bun-only corner.
 */
export const openPair = async (path = ":memory:"): Promise<SqliteDriver> => {
  const db = new Database(path, { create: true, strict: true });
  const driver = sqliteDriver({
    exec: (sql) => db.run(sql),
    run: (sql, params) => void db.run(sql, [...params]),
    // SAFETY: SQLite hands back text, integers, reals, blobs and NULL — exactly SqlValue
    all: (sql, params) => db.query(sql).values(...params) as readonly SqlRow[],
    close: () => db.close(),
  });
  // `:memory:` attaches a second, private in-memory database — a real log, for a test that is
  // not testing durability
  await attachLog(driver, path === ":memory:" ? ":memory:" : `${path}.log`);
  return driver;
};

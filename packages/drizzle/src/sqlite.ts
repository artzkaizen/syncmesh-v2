import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import type { FaceDeps } from "./face.js";

import { createLive } from "./live.js";
import { createProxy } from "./proxy.js";
import { readPredicate, readScope } from "./read.js";

export type SqliteMeshDb = SqliteRemoteDatabase<Record<string, never>>;

/** The SQLite face: Drizzle's `sqlite-proxy` over the device's own connection. */
export function sqliteFace(deps: FaceDeps) {
  const { engine, partition, driver, writer } = deps;
  const proxyDeps = { driver, writer };
  if (partition !== undefined) Object.assign(proxyDeps, { partition });
  const { callback } = createProxy(proxyDeps);
  const db: SqliteMeshDb = drizzle((statement, params, method) =>
    callback(statement, params, method),
  );
  const scope = readScope("sqlite", deps);
  /** The table as this principal may read it: a subquery with the `read` rule (and the pin) compiled in. */
  const read = <T extends SQLiteTable>(table: T) => {
    const name = getTableName(table);
    return db.select().from(table).where(readPredicate(name, scope)).as(name);
  };
  return { db, read, live: createLive(engine) };
}

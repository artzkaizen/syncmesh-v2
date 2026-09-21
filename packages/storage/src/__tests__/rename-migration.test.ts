import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { SqlRow, SqliteDriver } from "../driver.js";

import { openStores } from "../open-stores.js";
import { sqliteDriver } from "../sqlite-driver.js";

/**
 * A database written before the namespace existed still opens, with its log.
 *
 * The rename (RFC-0022) moves seven tables that shipped under bare names, and every device that
 * ever ran this holds them under the old ones. `ALTER TABLE … RENAME TO` is the only thing that
 * can move *those* — so what is asserted here is not that the new names exist, which any fresh
 * database would satisfy, but that **a row written under the old name is readable under the new
 * one**. That is the difference between a migration and a fresh start nobody noticed.
 */

/** A database at `user_version = 4`: what the four original migration steps left behind. */
const asItShipped = (path: string): SqliteDriver => {
  const db = new Database(path, { create: true, strict: true });
  db.run(`CREATE TABLE events (
    peer TEXT NOT NULL, seq INTEGER NOT NULL, local INTEGER NOT NULL,
    hlc_ms INTEGER NOT NULL, hlc_logical INTEGER NOT NULL, partition TEXT,
    core BLOB NOT NULL, sig BLOB, PRIMARY KEY (peer, seq, local)) WITHOUT ROWID`);
  db.run(`CREATE INDEX events_hlc ON events (hlc_ms, hlc_logical)`);
  db.run(`CREATE TABLE state_rows (tbl TEXT NOT NULL, key TEXT NOT NULL, record BLOB NOT NULL,
    PRIMARY KEY (tbl, key)) WITHOUT ROWID`);
  db.run(`CREATE TABLE state_cursors (peer TEXT NOT NULL, local INTEGER NOT NULL,
    seq INTEGER NOT NULL, PRIMARY KEY (peer, local)) WITHOUT ROWID`);
  db.run(`CREATE TABLE compaction (peer TEXT NOT NULL, local INTEGER NOT NULL, seq INTEGER NOT NULL,
    hlc_ms INTEGER NOT NULL, hlc_logical INTEGER NOT NULL, PRIMARY KEY (peer, local)) WITHOUT ROWID`);
  db.run(
    `CREATE TABLE state_scope (id INTEGER PRIMARY KEY CHECK (id = 0), scope TEXT NOT NULL) WITHOUT ROWID`,
  );
  // one event and one folded row, so the assertion is about data rather than about schema
  db.run(`INSERT INTO events VALUES ('aa', 1, 0, 100, 0, NULL, x'01', NULL)`);
  db.run(`INSERT INTO state_rows VALUES ('note', 'n1', x'02')`);
  db.run(`INSERT INTO state_cursors VALUES ('aa', 0, 1)`);
  db.run(`PRAGMA user_version = 4`);
  return sqliteDriver({
    exec: (sql) => db.run(sql),
    run: (sql, params) => void db.run(sql, [...params]),
    // SAFETY: SQLite hands back text, integers, reals, blobs and NULL — exactly SqlValue
    all: (sql, params) => db.query(sql).values(...params) as readonly SqlRow[],
    close: () => db.close(),
  });
};

describe("the syncmesh namespace, arriving at a database that predates it", () => {
  test("a log written under the old names is readable under the new ones", async () => {
    const path = `/tmp/syncmesh-rename-${String(Date.now())}.db`;
    const driver = asItShipped(path);

    (await openStores(driver)).unwrap();

    // the rows moved with their tables; nothing was recreated empty
    const [event] = await driver.all(`SELECT peer, seq FROM syncmesh_events`);
    expect(event).toEqual(["aa", 1]);
    const [row] = await driver.all(`SELECT tbl, key FROM syncmesh_state_rows`);
    expect(row).toEqual(["note", "n1"]);
    const [cursor] = await driver.all(`SELECT peer, seq FROM syncmesh_cursors`);
    expect(cursor).toEqual(["aa", 1]);

    // and the old names are gone rather than shadowed by empty copies
    const left = await driver.all(
      `SELECT name FROM sqlite_master WHERE name IN ('events','state_rows','state_cursors','state_scope','compaction')`,
    );
    expect(left).toEqual([]);

    // the index came with them, under the new name
    const [index] = await driver.all(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'syncmesh%'`,
    );
    expect(index).toEqual(["syncmesh_events_hlc"]);
    await driver.close?.();
  });

  test("opening it again moves nothing, because the version says it is done", async () => {
    const path = `/tmp/syncmesh-rename-twice-${String(Date.now())}.db`;
    const driver = asItShipped(path);
    (await openStores(driver)).unwrap();
    (await openStores(driver)).unwrap();
    const [event] = await driver.all(`SELECT peer, seq FROM syncmesh_events`);
    expect(event).toEqual(["aa", 1]);
    await driver.close?.();
  });
});

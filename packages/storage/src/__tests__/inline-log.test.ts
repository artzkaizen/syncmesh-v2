import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { SqlRow, SqliteDriver } from "../driver.js";

import { SQLITE, SQLITE_INLINE, dialectOf, logTable, placementOf } from "../dialect.js";
import { A, entry } from "../driver-tests/fixtures.js";
import { sqlEventStore } from "../event-store.js";
import { sqliteDriver } from "../sqlite-driver.js";

/** One database, nothing attached — what `ctx.storage.sql` gives a Durable Object. */
const oneDatabase = (): SqliteDriver => {
  const db = new Database(":memory:", { create: true, strict: true });
  return {
    ...sqliteDriver({
      exec: (sql) => db.run(sql),
      run: (sql, params) => void db.run(sql, [...params]),
      // SAFETY: SQLite hands back text, integers, reals, blobs and NULL — exactly SqlValue
      all: (sql, params) => db.query(sql).values(...params) as readonly SqlRow[],
      close: () => db.close(),
    }),
    log: "inline",
  };
};

/** Every statement a migration runs, without running one. */
const statementsOf = async (dialect: typeof SQLITE): Promise<readonly string[]> => {
  const seen: string[] = [];
  await dialect.migrate({
    run: async (sql) => void seen.push(sql),
    all: async (sql) => {
      seen.push(sql);
      return [];
    },
  });
  return seen;
};

describe("a runtime with no ATTACH still gets the namespace", () => {
  test("the inline dialect emits no ATTACH, no PRAGMA and no qualified name", async () => {
    const statements = await statementsOf(SQLITE_INLINE);
    expect(statements.length).toBeGreaterThan(0);
    // the three things a Durable Object's SQL surface refuses, and the one the fake would not:
    // `bun:sqlite` takes a PRAGMA happily, so only an assertion keeps this true
    for (const sql of statements) {
      expect(sql).not.toMatch(/\bATTACH\b/i);
      expect(sql).not.toMatch(/\bPRAGMA\b/i);
      expect(sql).not.toContain("syncmesh.");
    }
    // and it is the same ladder, not a shorter one: both halves are still created
    const created = statements.filter((sql) => sql.includes("CREATE TABLE"));
    expect(created.some((sql) => sql.includes("syncmesh_events"))).toBe(true);
    expect(created.some((sql) => sql.includes("syncmesh_state_rows"))).toBe(true);
  });

  test("the attached dialect still uses both, which is what makes the two different", async () => {
    const statements = await statementsOf(SQLITE);
    expect(statements.some((sql) => /\bPRAGMA\b/i.test(sql))).toBe(true);
    expect(statements.some((sql) => sql.includes("syncmesh.events"))).toBe(true);
  });

  test("the driver picks the spelling, and one database is enough to open a store", async () => {
    const driver = oneDatabase();
    expect(placementOf(driver)).toBe("inline");
    expect(dialectOf(driver)).toBe(SQLITE_INLINE);
    expect(logTable("events", placementOf(driver))).toBe("syncmesh_events");

    const store = (await sqlEventStore(driver)).unwrap();
    (await store.appendBatch([entry(A, 1, 100), entry(A, 2, 200)])).unwrap();
    expect((await store.all()).unwrap()).toHaveLength(2);
    // the ladder's position is a row rather than a user_version, so a second open is a no-op
    const again = (await sqlEventStore(driver)).unwrap();
    expect((await again.all()).unwrap()).toHaveLength(2);
    await driver.close?.();
  });

  test("a device is unaffected: the same driver without the flag attaches as before", () => {
    expect(placementOf({ dialect: "sqlite" })).toBe("attached");
    expect(placementOf({})).toBe("attached");
    // postgres has a real schema, so the flag is not its question to answer
    expect(placementOf({ dialect: "postgres", log: "inline" })).toBe("attached");
  });
});

import type { SqlRow } from "@syncmesh/storage";

import { captureTests, storeTests } from "@syncmesh/storage/driver-tests";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { ExpoBindValue } from "../driver.js";

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
const fakeExpo = (path: string) => {
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
  };
};

describe("@syncmesh/sqlite-expo passes the store contract", () => {
  // one database per name, kept alive across a driver's `close`, so a case that reopens by name
  // finds what it wrote — a phone's file outlives the connection the same way
  const databases = new Map<string, ReturnType<typeof fakeExpo>>();
  const openDriver = (name: string) => {
    const held = databases.get(name) ?? fakeExpo(":memory:");
    databases.set(name, held);
    const driver = expoSqliteDriverOver(held);
    return Promise.resolve({ ...driver, close: () => Promise.resolve() });
  };
  for (const c of [...storeTests(openDriver), ...captureTests(openDriver)]) test(c.name, c.run);
});

describe("a row arrives as the values the SELECT named", () => {
  test("values come back positionally, in column order", async () => {
    const driver = expoSqliteDriverOver(fakeExpo(":memory:"));
    await driver.run(`CREATE TABLE t (a TEXT, b INTEGER, c BLOB)`);
    await driver.run(`INSERT INTO t (a, b, c) VALUES (?, ?, ?)`, [
      "one",
      2,
      Uint8Array.from([3, 4]),
    ]);

    // the order is the statement's, not the table's
    expect(await driver.all(`SELECT b, a FROM t`, [])).toEqual([[2, "one"]]);
    const [row] = await driver.all(`SELECT c FROM t`, []);
    // SAFETY: column `c` was written as a BLOB two lines up, and SQLite answers a BLOB with the
    // bytes it stored — the assertion names the one arm of `SqlValue` this SELECT can produce
    expect(Array.from(row?.[0] as Uint8Array)).toEqual([3, 4]);
    await driver.close?.();
  });

  /**
   * The bug this adapter shipped with, kept as a test.
   *
   * Reading rows as objects and turning them back into positions with `Object.values` is wrong the
   * moment a statement names one column twice — which Drizzle does whenever a query reads from a
   * subquery or a join, and this library's read policy makes a subquery of every table. The object
   * keeps one of the two, the array comes back a value short, and every field after the collision
   * lands in the wrong place: on a phone that showed as issues with a status and no id, and a list
   * keyed on id that saw `null`.
   */
  test("a statement naming one column twice answers with both values", async () => {
    const driver = expoSqliteDriverOver(fakeExpo(":memory:"));
    await driver.run(`CREATE TABLE t (a TEXT, b TEXT)`);
    await driver.run(`INSERT INTO t (a, b) VALUES (?, ?)`, ["first", "second"]);

    expect(await driver.all(`SELECT a, a, b FROM t`, [])).toEqual([["first", "first", "second"]]);
    await driver.close?.();
  });
});

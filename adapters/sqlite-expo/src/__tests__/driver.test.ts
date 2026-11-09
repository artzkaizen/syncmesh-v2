import { attachLog } from "@syncmesh/storage";
import { captureTests, storeTests } from "@syncmesh/storage/driver-tests";
import { describe, expect, test } from "bun:test";

import { expoSqliteDriverOver } from "../driver.js";
import { fakeExpo } from "./fake-expo.js";

describe("@syncmesh/sqlite-expo passes the store contract", () => {
  // one database per name, kept alive across a driver's `close`, so a case that reopens by name
  // finds what it wrote — a phone's file outlives the connection the same way
  const databases = new Map<string, ReturnType<typeof fakeExpo>>();
  const openDriver = async (name: string) => {
    const known = databases.get(name);
    const held = known ?? fakeExpo(":memory:");
    databases.set(name, held);
    const driver = expoSqliteDriverOver(held);
    // a store opens only over a connection with the log attached as `syncmesh` (RFC-0022). On a
    // phone the adapter's own `attachLog(driver, logPath)` does this; here the fake does it once
    // per database, because the connection outlives every `close` above
    if (known === undefined) await attachLog(driver, ":memory:");
    return { ...driver, close: () => Promise.resolve() };
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

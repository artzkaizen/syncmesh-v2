import { storeTests } from "@syncmesh/storage/driver-tests";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doSqliteDriver } from "../driver.js";
import { durableSqlOver } from "./durable-sql.js";

const dir = mkdtempSync(join(tmpdir(), "syncmesh-do-driver-"));
const open = (name: string) =>
  Promise.resolve(doSqliteDriver(durableSqlOver(new Database(join(dir, `${name}.db`)))));

/**
 * The one case this driver cannot pass, and why: it asks that a commit failing halfway leave
 * nothing behind, which needs `SqlDriver.transaction`. A Durable Object's only transaction is
 * `ctx.storage.transactionSync`, which must finish before it returns — an async port cannot use
 * it. The turn's implicit transaction covers a crash and not a caught failure, so the gap is
 * real and named here rather than hidden behind a driver that pretends to roll back.
 */
const NEEDS_A_TRANSACTION = "state: a commit that fails halfway leaves nothing behind";

describe("doSqliteDriver passes the store contract over a Durable Object's value set", () => {
  for (const c of storeTests(open)) {
    if (c.name !== NEEDS_A_TRANSACTION) test(c.name, c.run);
  }
});

describe("the conversions the platform forces", () => {
  test("bytes survive the ArrayBuffer round trip a Durable Object insists on", async () => {
    const driver = await open("bytes");
    await driver.run(`CREATE TABLE b (k TEXT PRIMARY KEY, v BLOB)`);
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
    await driver.run(`INSERT INTO b (k, v) VALUES (?, ?)`, ["k", bytes.subarray(8)]);

    const [row] = await driver.all(`SELECT v FROM b WHERE k = ?`, ["k"]);
    // a Uint8Array, not the ArrayBuffer the platform returned: every store above checks for one
    expect(row?.[0]).toBeInstanceOf(Uint8Array);
    expect(row?.[0]).toEqual(bytes.subarray(8)); // the window, never the buffer it looked into
  });

  test("a bigint past 2^53 is refused rather than bound as a different integer", async () => {
    const driver = await open("wide");
    await driver.run(`CREATE TABLE n (v INTEGER)`);
    await expect(driver.run(`INSERT INTO n (v) VALUES (?)`, [2n ** 60n])).rejects.toThrow(
      "does not fit",
    );
    expect((await driver.all(`SELECT count(*) FROM n`))[0]?.[0]).toBe(0);
  });

  test("no transaction on the port: the object commits a turn, not a keyword", async () => {
    const driver = await open("turn");
    expect(driver.transaction).toBeUndefined();
  });
});

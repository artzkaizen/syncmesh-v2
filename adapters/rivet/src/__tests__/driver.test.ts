import { storeTests } from "@syncmesh/storage/driver-tests";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rivetSqlDriver } from "../driver.js";
import { rivetDbOver } from "./actor.js";

const dir = mkdtempSync(join(tmpdir(), "syncmesh-rivet-driver-"));
const open = (name: string) =>
  Promise.resolve(rivetSqlDriver(rivetDbOver(new Database(join(dir, `${name}.db`)))));

describe("rivetSqlDriver passes the store contract over object rows and Rivet's value set", () => {
  for (const c of storeTests(open)) test(c.name, c.run);
});

describe("the conversions the platform forces", () => {
  test("object rows come back positional, in the order the statement selected them", async () => {
    const driver = await open("order");
    await driver.run(`CREATE TABLE r (a TEXT, b INTEGER, c BLOB)`);
    await driver.run(`INSERT INTO r (a, b, c) VALUES (?, ?, ?)`, ["x", 2, Uint8Array.of(1, 2)]);
    expect(await driver.all(`SELECT c, a, b FROM r`)).toEqual([[Uint8Array.of(1, 2), "x", 2]]);
  });

  test("a boolean binds as an integer, which Rivet's SQLite takes and a boolean it does not", async () => {
    const driver = await open("bool");
    await driver.run(`CREATE TABLE f (v INTEGER)`);
    await driver.run(`INSERT INTO f (v) VALUES (?)`, [true]);
    expect((await driver.all(`SELECT v FROM f`))[0]?.[0]).toBe(1);
  });

  test("a transaction that throws leaves nothing behind", async () => {
    const driver = await open("tx");
    await driver.run(`CREATE TABLE t (v INTEGER)`);
    const { transaction } = driver;
    expect(transaction).toBeDefined();
    if (transaction === undefined) return;
    const failed = transaction(async () => {
      await driver.run(`INSERT INTO t (v) VALUES (?)`, [1]);
      throw new Error("halfway");
    });
    expect(await failed.then(String, (cause: Error) => cause.message)).toBe("halfway");
    expect((await driver.all(`SELECT count(*) FROM t`))[0]?.[0]).toBe(0);
  });
});

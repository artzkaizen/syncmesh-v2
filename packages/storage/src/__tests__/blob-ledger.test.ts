import { describe, expect, test } from "bun:test";

import type { SqlDriver } from "../driver.js";

import { sqlBlobLedger } from "../blob-ledger.js";

describe("a Postgres blob ledger (gaps U18)", () => {
  test("is refused at the open over a driver with no transactions, and writes nothing", async () => {
    const ran: string[] = [];
    // a Postgres connection that commits one statement at a time: no lock outlives a statement
    const bare = {
      dialect: "postgres",
      run: (sql) => Promise.resolve(void ran.push(sql)),
      all: (sql) => Promise.resolve(void ran.push(sql)).then(() => []),
    } satisfies SqlDriver;
    const opened = await sqlBlobLedger(bare);
    expect(opened.isErr() && opened.error._tag).toBe("StoreFailure");
    expect(opened.isErr() && opened.error.message).toContain("needs a driver with transactions");
    expect(ran).toEqual([]);

    // the same connection that can hold a transaction opens
    const held = await sqlBlobLedger({ ...bare, transaction: (fn) => fn() });
    expect(held.isOk()).toBe(true);
  });
});

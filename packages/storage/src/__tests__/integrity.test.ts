import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { SqlRow, SqliteDriver } from "../driver.js";

import { sqliteEventStore } from "../event-store.js";
import { verifyLog } from "../integrity.js";
import { sqliteDriver } from "../sqlite-driver.js";

/**
 * An inline log (`log: "inline"`, as a Durable Object and a Rivet actor keep it) over one
 * `bun:sqlite` database, with `refuse` standing in for a runtime's authorizer: a statement it
 * matches is turned away the way workerd turns away a `PRAGMA` it does not allow.
 */
const inline = (refuse?: RegExp, answer = "not authorized: SQLITE_AUTH"): SqliteDriver => {
  const db = new Database(":memory:", { strict: true });
  const authorize = (sql: string) => {
    if (refuse?.test(sql)) throw new Error(answer);
  };
  return {
    ...sqliteDriver({
      exec: (sql) => db.run(sql),
      run: (sql, params) => {
        authorize(sql);
        db.run(sql, [...params]);
      },
      all: (sql, params) => {
        authorize(sql);
        // SAFETY: SQLite hands back text, integers, reals, blobs and NULL — exactly SqlValue
        return db.query(sql).values(...params) as readonly SqlRow[];
      },
      close: () => db.close(),
    }),
    log: "inline",
  };
};

describe("verifyLog on an inline log (D39)", () => {
  test("checks each log table's pages where the runtime allows quick_check, as workerd does", async () => {
    const driver = inline();
    (await sqliteEventStore(driver)).unwrap();
    expect((await verifyLog(driver)).isOk()).toBe(true);
  });

  test("a runtime that refuses the PRAGMA answers NoIntegrityCheck, not damage", async () => {
    const driver = inline(/^PRAGMA/);
    (await sqliteEventStore(driver)).unwrap();
    const verified = await verifyLog(driver);
    expect(verified.isErr() && verified.error._tag).toBe("NoIntegrityCheck");
  });

  test("a refusal in a runtime's own words is still NoIntegrityCheck, not damage", async () => {
    const driver = inline(/^PRAGMA/, "PRAGMA statements are not supported by this actor");
    (await sqliteEventStore(driver)).unwrap();
    const verified = await verifyLog(driver);
    expect(verified.isErr() && verified.error._tag).toBe("NoIntegrityCheck");
  });

  test("a check that fails in any other words is damage, as workerd reports a torn page", async () => {
    const driver = inline(/^PRAGMA/, "false == true");
    (await sqliteEventStore(driver)).unwrap();
    const verified = await verifyLog(driver);
    expect(verified.isErr() && verified.error._tag).toBe("StoreFailure");
  });
});

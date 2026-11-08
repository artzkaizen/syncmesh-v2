import { PGlite } from "@electric-sql/pglite";
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";
import { openStores, verifyLog } from "@syncmesh/storage";
import { CRASH_AUTHOR, entry } from "@syncmesh/storage/driver-tests";
import { describe, expect, test } from "bun:test";

import { pgliteDriver } from "../index.js";

/**
 * `verifyLog` on Postgres (D39): `amcheck` where the extension is installed, and an honest
 * `NoIntegrityCheck` where it is not — creating an extension is the operator's call, not a side
 * effect of a read.
 */
describe("@syncmesh/postgres checks its log's pages with amcheck", () => {
  test("without amcheck installed, the check says it has none rather than passing", async () => {
    const db = new PGlite();
    const driver = pgliteDriver(db);
    (await openStores(driver)).unwrap();
    const verified = await verifyLog(driver);
    expect(verified.isErr() && verified.error._tag).toBe("NoIntegrityCheck");
    await db.close();
  });

  test("with amcheck installed, a sound log passes heap and index checks", async () => {
    const db = new PGlite({ extensions: { amcheck } });
    await db.exec("CREATE EXTENSION amcheck");
    const driver = pgliteDriver(db);
    const stores = (await openStores(driver)).unwrap();
    const events = [entry(CRASH_AUTHOR, 1, 10), entry(CRASH_AUTHOR, 3, 30)];
    (await stores.events.appendBatch(events)).unwrap();
    const verified = await verifyLog(driver);
    expect(verified.isOk()).toBe(true);
    await db.close();
  });
});

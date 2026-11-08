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

  test("a role that may not run amcheck is told so, and a sound log is not called damaged", async () => {
    const db = new PGlite({ extensions: { amcheck } });
    await db.exec("CREATE EXTENSION amcheck");
    const driver = pgliteDriver(db);
    const stores = (await openStores(driver)).unwrap();
    (await stores.events.appendBatch([entry(CRASH_AUTHOR, 1, 10)])).unwrap();
    // what an app's role has by default: the log's schema, and no grant on amcheck's functions
    await driver.run(`CREATE ROLE syncmesh_app NOLOGIN`);
    await driver.run(`GRANT USAGE ON SCHEMA syncmesh TO syncmesh_app`);
    await driver.run(`GRANT SELECT ON ALL TABLES IN SCHEMA syncmesh TO syncmesh_app`);
    await driver.run(`SET ROLE syncmesh_app`);
    const verified = await verifyLog(driver);
    expect(verified.isErr() && verified.error._tag).toBe("NoIntegrityCheck");
    await driver.run(`RESET ROLE`);
    await db.close();
  });

  test("a grant on another overload of amcheck's functions is not a grant on the one it calls", async () => {
    const db = new PGlite({ extensions: { amcheck } });
    await db.exec("CREATE EXTENSION amcheck");
    const driver = pgliteDriver(db);
    const stores = (await openStores(driver)).unwrap();
    (await stores.events.appendBatch([entry(CRASH_AUTHOR, 1, 10)])).unwrap();
    await driver.run(`CREATE ROLE syncmesh_app NOLOGIN`);
    await driver.run(`GRANT USAGE ON SCHEMA syncmesh TO syncmesh_app`);
    await driver.run(`GRANT SELECT ON ALL TABLES IN SCHEMA syncmesh TO syncmesh_app`);
    await driver.run(`GRANT EXECUTE ON FUNCTION verify_heapam TO syncmesh_app`);
    await driver.run(`GRANT EXECUTE ON FUNCTION bt_index_check(regclass) TO syncmesh_app`);
    await driver.run(`SET ROLE syncmesh_app`);
    const narrow = await verifyLog(driver);
    expect(narrow.isErr() && narrow.error._tag).toBe("NoIntegrityCheck");
    await driver.run(`RESET ROLE`);
    await driver.run(`GRANT EXECUTE ON FUNCTION bt_index_check(regclass, boolean) TO syncmesh_app`);
    await driver.run(`SET ROLE syncmesh_app`);
    const granted = await verifyLog(driver);
    expect(granted.isOk() ? "ok" : granted.error.message).toBe("ok");
    await driver.run(`RESET ROLE`);
    await db.close();
  });
});

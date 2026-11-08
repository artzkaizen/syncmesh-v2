import { parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { syncSchema, t } from "@syncmesh/schema";
import { describe, expect, test } from "bun:test";

import type { SqlDriver } from "../driver.js";

import { openStores, schemaName } from "../open-stores.js";
import { openPair } from "./pair.js";

/**
 * Strict capture at the open (gaps U5): `openStores` installs the guard by default, records it in
 * a row of its own beside the schema's, and changes it at the next open — without counting the
 * change as a new shape of the tables, which a compacted log would refuse.
 */

const schema = syncSchema({
  tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } },
});
const tables = [schema.tables.notes];
const AUTHOR = parsePeerId("a".repeat(64)).unwrap();

const raw = async (driver: SqlDriver) =>
  (
    await Result.tryPromise({
      try: () => driver.run(`INSERT INTO notes (id, body) VALUES ('raw', 'x')`),
      catch: (cause) => String(cause),
    })
  ).match({
    ok: () => "applied",
    err: (message) => (message.includes("outside a captured write") ? "refused" : message),
  });

const schemaRow = async (driver: SqlDriver) =>
  (await driver.all(`SELECT value FROM syncmesh.meta WHERE key = 'schema'`))[0]?.[0];

describe("strict capture at the open", () => {
  test("is on by default", async () => {
    const driver = await openPair(":memory:", schemaName(tables));
    (await openStores(driver, { tables })).unwrap();
    expect(await raw(driver)).toBe("refused");
  });

  test("a database opened before U5 gets the guard at its next open, and keeps its schema row", async () => {
    const driver = await openPair(":memory:", schemaName(tables));
    (await openStores(driver, { tables })).unwrap();
    const fingerprint = await schemaRow(driver);
    // what a build before U5 left: no guard triggers, no guard row
    for (const op of ["INSERT", "UPDATE", "DELETE"])
      await driver.run(`DROP TRIGGER "_syncmesh_strict.notes.${op}"`);
    await driver.run(`DELETE FROM syncmesh.meta WHERE key = 'guard'`);
    expect(await raw(driver)).toBe("applied");
    await driver.run(`DELETE FROM notes`);
    (await openStores(driver, { tables })).unwrap();
    expect(await raw(driver)).toBe("refused");
    expect(await schemaRow(driver)).toBe(fingerprint);
  });

  test("turning it off is no shape change: a log that cannot refold still opens", async () => {
    const driver = await openPair(":memory:", schemaName(tables));
    const stores = (await openStores(driver, { tables })).unwrap();
    // a snapshot install with no events behind it: this log can no longer rebuild every row, so a
    // changed table shape is refused at the open (U33)
    (await stores.events.recordInstalled(new Map([[AUTHOR, parseSeqNum(3).unwrap()]]))).unwrap();
    const fingerprint = await schemaRow(driver);
    const off = await openStores(driver, { tables, strict: false });
    expect(off.isOk()).toBe(true);
    expect(await raw(driver)).toBe("applied");
    expect(await schemaRow(driver)).toBe(fingerprint);
    await driver.run(`DELETE FROM notes`);
    (await openStores(driver, { tables, strict: { except: [] } })).unwrap();
    expect(await raw(driver)).toBe("refused");
  });
});

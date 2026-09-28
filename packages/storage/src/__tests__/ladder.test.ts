import { t, table } from "@syncmesh/schema";
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStores, schemaNameFor } from "../open-stores.js";
import { openPair } from "./pair.js";

const dir = mkdtempSync(join(tmpdir(), "syncmesh-ladder-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TABLES = [table("notes", { id: t.text().primaryKey(), body: t.text() })];

describe("a database past the top of the ladder", () => {
  /**
   * The single-file store that predates RFC-0022 is the live case: every install from before the
   * split has a `user_version` its combined ladder wrote, and the log's ladder now counts from
   * one. Under a `>=` that reads as current, the migration is skipped, and the failure surfaces
   * as `no such table: syncmesh.scope` at the first commit — which is where this was found.
   */
  test("is refused at open, rather than read as current", async () => {
    const log = join(dir, "from-the-old-shape.db");
    const db = new Database(log, { create: true, strict: true });
    db.run("PRAGMA user_version = 4");
    db.close();

    const driver = await openPair(log, schemaNameFor(TABLES));
    const opened = await openStores(driver, { tables: TABLES });
    expect(opened.isErr() && opened.error._tag).toBe("StoreFailure");
    // the number it is at and the number there are, because "your database is too new" without
    // either of them is a message you cannot act on
    expect(opened.isErr() && String(opened.error.cause)).toMatch(/step 4 of a schema that has 1/);
    await driver.close?.();
  });

  test("but the top itself opens, and opens again", async () => {
    const log = join(dir, "current.db");
    const first = await openPair(log, schemaNameFor(TABLES));
    (await openStores(first, { tables: TABLES })).unwrap();
    await first.close?.();

    // reopening is the case the guard must not catch: the ladder is at its top, not past it
    const again = await openPair(log, schemaNameFor(TABLES));
    (await openStores(again, { tables: TABLES })).unwrap();
    await again.close?.();
  });
});

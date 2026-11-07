import { PGlite } from "@electric-sql/pglite";
import { t, table } from "@syncmesh/schema";
import { openStores } from "@syncmesh/storage";
import { describe, expect, test } from "bun:test";

import { pgliteDriver } from "../index.js";

/** The Postgres half of the format-upgrade tests: the position is a row in `syncmesh.meta`. */
const TABLES = [table("notes", { id: t.text().primaryKey(), body: t.text() })];

describe("the Postgres ladder", () => {
  test("Postgres: syncmesh.meta records the version; a version from a newer build is refused as a value", async () => {
    const db = new PGlite();
    const driver = pgliteDriver(db);
    (await openStores(driver, { tables: TABLES })).unwrap();
    const [row] = await driver.all(`SELECT value FROM syncmesh.meta WHERE key = 'version'`, []);
    const top = Number(row?.[0]);
    expect(top).toBeGreaterThan(0);
    (await openStores(driver, { tables: TABLES })).unwrap();
    const [again] = await driver.all(`SELECT value FROM syncmesh.meta WHERE key = 'version'`, []);
    expect(Number(again?.[0])).toBe(top);

    await driver.run(`UPDATE syncmesh.meta SET value = $1 WHERE key = 'version'`, [`${top + 5}`]);
    const refused = await openStores(driver, { tables: TABLES });
    expect(refused.isErr() && refused.error._tag).toBe("StoreFailure");
    const cause = refused.isErr() ? refused.error.cause : undefined;
    expect(cause instanceof Error ? cause.message : "").toContain(
      `step ${top + 5} of a schema that has ${top}`,
    );
    await db.close();
  });
});

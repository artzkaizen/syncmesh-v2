import type { StrictCapture } from "@syncmesh/storage";

import { local, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";
import { sqlite } from "../options.js";

/**
 * Strict capture through the mesh (gaps U5): the app's own connection is the mesh's, so a raw
 * statement on it that skips `on().db` would change a synced row with no event behind it. The
 * mesh installs the guard by default, and its own writes and folds still land.
 */

const drafts = sqliteTable("drafts", { id: text().primaryKey(), body: text().notNull() });
const schema = syncSchema({
  tables: { drafts: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: local } },
});
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const open = async (strict?: StrictCapture) => {
  const driver = bunSqliteDriver(":memory:");
  const storage = sqlite({ driver, ...(strict !== undefined && { strict }) });
  const mesh = (await createMesh({ schema, identity: device, now: () => T0, storage })).unwrap();
  return { driver, mesh };
};

/** How a raw statement ended; a driver may throw before it returns a promise. */
const raw = (write: () => Promise<void>) =>
  Promise.resolve()
    .then(write)
    .then(
      () => "applied",
      (cause: unknown) =>
        String(cause).includes("outside a captured write") ? "refused" : String(cause),
    );

describe("strict capture on a mesh", () => {
  test("by default a raw write beside the mesh is refused, and the mesh's own still lands", async () => {
    const { driver, mesh } = await open();
    const { db } = mesh.on().unwrap();
    await db.insert(drafts).values({ id: "d1", body: "through the mesh" });
    expect(
      await raw(() => driver.run(`INSERT INTO drafts (id, body) VALUES ('d2', 'behind its back')`)),
    ).toBe("refused");
    expect(await raw(() => driver.run(`UPDATE drafts SET body = 'edited' WHERE id = 'd1'`))).toBe(
      "refused",
    );
    expect(await db.select().from(drafts)).toEqual([{ id: "d1", body: "through the mesh" }]);
    await mesh.stop();
  });

  test("`strict: false` lets the raw write through, as it did before U5", async () => {
    const { driver, mesh } = await open(false);
    expect(await raw(() => driver.run(`INSERT INTO drafts (id, body) VALUES ('d1', 'raw')`))).toBe(
      "applied",
    );
    await mesh.stop();
  });
});

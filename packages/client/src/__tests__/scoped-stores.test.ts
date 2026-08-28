import type { StoreScope } from "@syncmesh/storage";

import { parsePartitionKey } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { scopedStores, storeNameFor } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const schema = () =>
  defineSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } },
  });

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 40 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();

/** One file per scope under `dir` — the shape D07 asks for, and what a device really does. */
const setIn = (dir: string) => {
  const files = new Map<StoreScope, string>();
  const set = scopedStores({
    tables: schema().entries.map((e) => e.table),
    driverFor: (scope, name) => {
      const path = join(dir, `${name}.db`);
      files.set(scope, path);
      return bunSqliteDriver(path);
    },
  });
  return { set, fileFor: (scope: StoreScope) => files.get(scope) };
};

const meshOver = async (dir: string, set: ReturnType<typeof setIn>["set"], scope: StoreScope) => {
  const stores = (await set.storeFor(scope)).unwrap();
  return (
    await createMesh({
      schema: schema(),
      identity: device,
      authority: device.peerId,
      stores,
      dataDir: dir,
      now: () => T0,
    })
  ).unwrap();
};

describe("one mesh per top-level instance, over one database each (D07)", () => {
  test("logs never mix: a write in one org is not in the other's file at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-scoped-"));
    try {
      const { set, fileFor } = setIn(dir);
      const acme = await meshOver(dir, set, ACME);
      const globex = await meshOver(dir, set, GLOBEX);

      await acme.on().unwrap().db.insert(notes).values({ id: "n1", body: "acme's" });
      await globex.on().unwrap().db.insert(notes).values({ id: "n1", body: "globex's" });
      await acme.flush();
      await globex.flush();

      // the same row key in both, and neither can see the other's: there is no query that spans
      // two, because there is no connection that holds both
      expect((await acme.on().unwrap().db.select().from(notes))[0]?.body).toBe("acme's");
      expect((await globex.on().unwrap().db.select().from(notes))[0]?.body).toBe("globex's");

      expect(existsSync(join(dir, `${storeNameFor(ACME)}.db`))).toBe(true);
      expect(fileFor(ACME)).not.toBe(fileFor(GLOBEX));

      await acme.stop();
      await globex.stop();
      await set.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaving an org closes one store and deletes one file; the rest keep working", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-leaving-"));
    try {
      const { set, fileFor } = setIn(dir);
      const acme = await meshOver(dir, set, ACME);
      const globex = await meshOver(dir, set, GLOBEX);
      await globex.on().unwrap().db.insert(notes).values({ id: "keep", body: "still here" });
      await globex.flush();

      // stopping the mesh leaves the stores open, because the set is what knows they are done
      await acme.stop();
      expect(set.opened()).toEqual([ACME, GLOBEX]);

      await set.forget(ACME);
      const gone = fileFor(ACME);
      if (gone !== undefined) unlinkSync(gone);
      expect(set.opened()).toEqual([GLOBEX]);
      expect(existsSync(join(dir, `${storeNameFor(ACME)}.db`))).toBe(false);

      // and nothing of the other org went with it — the whole point of a file per scope
      expect((await globex.on().unwrap().db.select().from(notes))[0]?.body).toBe("still here");
      await globex.stop();
      await set.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a mesh over borrowed stores does not close them when it stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-borrowed-"));
    try {
      const { set } = setIn(dir);
      const first = await meshOver(dir, set, ACME);
      await first.on().unwrap().db.insert(notes).values({ id: "n1", body: "written once" });
      await first.flush();
      await first.stop();

      // the same stores, a second mesh over them: a `stop` that had closed the connection would
      // make this throw rather than read back
      const stores = (await set.storeFor(ACME)).unwrap();
      const rows = await stores.driver.all("SELECT body FROM notes");
      expect(rows[0]?.[0]).toBe("written once");
      await set.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

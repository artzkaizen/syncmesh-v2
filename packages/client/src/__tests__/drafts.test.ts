import { seed } from "@syncmesh/kernel/test-fixtures";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { defaultStore } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDrafts } from "../drafts.js";
import { createMesh } from "../mesh.js";

const schema = () =>
  syncSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } },
  });
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const identity = createIdentity(seed(7)).unwrap();

describe("drafts — local-only, with no replication promise (book ch. 8)", () => {
  test("saved, read back, forgotten — and never an event", async () => {
    const mesh = (
      await createMesh({
        driver: bunSqliteDriver(":memory:"),
        schema: schema(),
        identity,
        now: () => T0,
      })
    ).unwrap();
    const drafts = mesh.drafts ?? panicNoDrafts();

    (await drafts.save("note:new", "half a sentence")).unwrap();
    expect((await drafts.get("note:new")).unwrap()).toBe("half a sentence");

    (await drafts.save("note:new", "half a sentence, revised")).unwrap();
    expect((await drafts.get("note:new")).unwrap()).toBe("half a sentence, revised");

    // a draft is one device's business: replicating it would mean merging two half-finished
    // sentences, which is the one thing the lattice cannot make sensible
    expect((await mesh.engine.eventsSince(new Map())).unwrap()).toEqual([]);

    (await drafts.forget("note:new")).unwrap();
    expect((await drafts.get("note:new")).unwrap()).toBeUndefined();
    await mesh.stop();
  });

  test("a draft outlives the process that wrote it — that is the whole point of keeping one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-drafts-"));
    const open = async () => {
      const stores = (await defaultStore({ name: "drafts", dir, tables: [] })).unwrap();
      const mesh = (
        await createMesh({ stores, schema: schema(), identity, now: () => T0 })
      ).unwrap();
      return { mesh, close: () => stores.close() };
    };

    const first = await open();
    (await (first.mesh.drafts ?? panicNoDrafts()).save("form", "unsent")).unwrap();
    await first.mesh.stop();
    await first.close();

    const second = await open();
    expect((await (second.mesh.drafts ?? panicNoDrafts()).get("form")).unwrap()).toBe("unsent");
    await second.mesh.stop();
    await second.close();
  });

  test("a ttl makes the row read as absent past its hour, and the sweep counts it", async () => {
    let at = T0;
    const drafts = createDrafts(bunSqliteDriver(":memory:"), { now: () => at });
    const hour = Temporal.Duration.from({ hours: 1 });

    (await drafts.save("session", "token", { ttl: hour })).unwrap();
    expect((await drafts.get("session")).unwrap()).toBe("token");

    // immortal rows are untouched by time and by the sweep
    (await drafts.save("forever", "kept")).unwrap();
    at = Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + 3_600_000);
    expect((await drafts.get("session")).unwrap()).toBeUndefined();
    expect((await drafts.get("forever")).unwrap()).toBe("kept");
    expect((await drafts.sweep()).unwrap()).toBe(0);

    // a fresh ttl row, swept while expired rather than read
    (await drafts.save("session", "token", { ttl: hour })).unwrap();
    at = Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + 7_200_000);
    expect((await drafts.sweep()).unwrap()).toBe(1);
    expect((await drafts.get("session")).unwrap()).toBeUndefined();
    expect((await drafts.get("forever")).unwrap()).toBe("kept");
  });

  test("saves and forgets broadcast the key; expiry is observed on read, not pushed", async () => {
    const drafts = createDrafts(bunSqliteDriver(":memory:"), { now: () => T0 });
    const seen: string[] = [];
    const off = drafts.onChange((key) => void seen.push(key));

    (await drafts.save("a", "1")).unwrap();
    (await drafts.save("b", "2", { ttl: Temporal.Duration.from({ hours: 1 }) })).unwrap();
    (await drafts.forget("a")).unwrap();
    expect(seen).toEqual(["a", "b", "a"]);

    off();
    (await drafts.save("c", "3")).unwrap();
    expect(seen).toEqual(["a", "b", "a"]);
  });

  test("a table from before expiry existed gains the column and keeps its rows", async () => {
    const driver = bunSqliteDriver(":memory:");
    await driver.run(`CREATE TABLE syncmesh_drafts (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await driver.run(`INSERT INTO syncmesh_drafts (key, value) VALUES ('old', 'kept')`);

    const drafts = createDrafts(driver, { now: () => T0 });
    // old rows have no expiry: they read back and never expire
    expect((await drafts.get("old")).unwrap()).toBe("kept");
    // and new rows with a ttl work beside them
    (await drafts.save("new", "v", { ttl: Temporal.Duration.from({ hours: 1 }) })).unwrap();
    expect((await drafts.get("new")).unwrap()).toBe("v");
  });
});

const panicNoDrafts = () => {
  throw new Error("a mesh with a connection keeps drafts");
};

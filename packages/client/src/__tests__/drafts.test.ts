import { seed } from "@syncmesh/kernel/test-fixtures";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { defaultStore } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
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
});

const panicNoDrafts = () => {
  throw new Error("a mesh with a connection keeps drafts");
};

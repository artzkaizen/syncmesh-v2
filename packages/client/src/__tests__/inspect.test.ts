import type { Procedure, RowKey } from "@syncmesh/kernel";

import { createMemoryEventStore } from "@syncmesh/engine";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { local, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";
import { sqlite } from "../options.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text() });
const schema = () =>
  syncSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } },
  });
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
// SAFETY: test fixtures; the naming rules are not what these tests are about
const procedureName = (name: string) => name as Procedure;
// SAFETY: as above, a row key is opaque text
const rowKey = (key: string) => key as RowKey;

const device = async () =>
  (
    await createMesh({
      schema: schema(),
      identity: createIdentity(seed(7)).unwrap(),
      now: () => T0,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
    })
  ).unwrap();

describe("inspect.handles", () => {
  test("a clean mesh counts zero everywhere", async () => {
    const mesh = await device();
    expect(mesh.inspect.handles()).toEqual({
      observers: 0,
      subscriptions: 0,
      operations: 0,
      fetches: 0,
      links: 0,
    });
    await mesh.stop();
  });

  test("a live query and its listener take seats; release gives them back exactly once", async () => {
    const mesh = await device();
    const handle = mesh.on().unwrap();
    const live = handle.live(handle.db.select().from(notes));
    await live.ready;
    expect(mesh.inspect.handles().observers).toBe(1);

    const off = live.subscribe(() => undefined);
    expect(mesh.inspect.handles().subscriptions).toBe(1);
    off();
    off(); // idempotent: a second call must not go negative
    expect(mesh.inspect.handles().subscriptions).toBe(0);

    live.release();
    live.release();
    expect(mesh.inspect.handles().observers).toBe(0);
    await mesh.stop();
  });

  test("mesh-level listeners are counted, and `using` disposes them", async () => {
    const mesh = await device();
    {
      using heldTelemetry = mesh.onTelemetry(() => undefined);
      expect(heldTelemetry[Symbol.dispose]).toBeDefined();
      expect(mesh.inspect.handles().subscriptions).toBe(1);
    }
    expect(mesh.inspect.handles().subscriptions).toBe(0);
    await mesh.stop();
  });

  test("a dropped live query leaks loudly instead of vanishing", async () => {
    const mesh = await device();
    const handle = mesh.on().unwrap();
    await handle.live(handle.db.select().from(notes)).ready;
    // nobody kept the reference — the seat stays taken, which is the point
    expect(mesh.inspect.handles().observers).toBe(1);
    await mesh.stop();
  });
});

describe("inspect.verify", () => {
  test("checks the log's pages, and a sound log passes", async () => {
    const mesh = await device();
    expect((await mesh.inspect.verify()).isOk()).toBe(true);
    await mesh.stop();
  });

  test("a mesh over a bare event store says it has no pages to check", async () => {
    const mesh = (
      await createMesh({
        schema: schema(),
        identity: createIdentity(seed(7)).unwrap(),
        now: () => T0,
        storage: sqlite({ store: createMemoryEventStore() }),
      })
    ).unwrap();
    const verified = await mesh.inspect.verify();
    expect(verified.isErr() && verified.error._tag).toBe("NoSuchCapability");
    await mesh.stop();
  });

  test("stopping over the app's own connection marks the session clean and leaves it open", async () => {
    const driver = bunSqliteDriver(":memory:");
    const mesh = (
      await createMesh({
        schema: schema(),
        identity: createIdentity(seed(7)).unwrap(),
        now: () => T0,
        storage: sqlite({ driver }),
      })
    ).unwrap();
    const ended = () => driver.all(`SELECT value FROM syncmesh.meta WHERE key = 'session'`);
    expect(await ended()).toEqual([["open"]]);
    await mesh.stop();
    // without this the next launch would check every page as if the last one had crashed (D39)
    expect(await ended()).toEqual([["closed"]]);
  });
});

describe("inspect.fleet (D31)", () => {
  test("the manifest's schemaVersion is stamped on what this device writes, and read back", async () => {
    const versioned = syncSchema({
      schemaVersion: 2,
      tables: {
        drafts: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: local },
      },
    });
    const mesh = (
      await createMesh({
        schema: versioned,
        identity: createIdentity(seed(8)).unwrap(),
        now: () => T0,
        storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
      })
    ).unwrap();
    const drafts = versioned.tables.drafts;
    const written = await mesh.engine.mutate(
      procedureName("drafts.create"),
      (tx) =>
        tx.insert(
          drafts.name,
          rowKey("d1"),
          new Map([
            [drafts.columnNames.id, "d1"],
            [drafts.columnNames.body, "x"],
          ]),
        ),
      { local: true },
    );
    expect<number | undefined>(written.unwrap().schemaVersion).toBe(2);
    const self = mesh.engine.peerId;
    expect<number | undefined>(mesh.inspect.fleet.oldestSchema().get(self)?.version).toBe(2);
    // within a window the reading is judged by the event's own stamp, against the mesh's clock
    const minute = Temporal.Duration.from({ minutes: 1 });
    expect(mesh.inspect.fleet.oldestSchema({ within: minute }).has(self)).toBe(true);
    await mesh.stop();
  });
});

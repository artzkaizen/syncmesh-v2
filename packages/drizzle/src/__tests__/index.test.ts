import type { Principal } from "@syncmesh/engine";

import { createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { openStores } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { meshDrizzle } from "../index.js";

// the app's table, as Drizzle knows it …
const jobs = sqliteTable("jobs", {
  id: text().primaryKey(),
  title: text().notNull(),
  status: text().notNull(),
  assignee: text(),
  rank: integer().notNull(),
});

// … and what syncing it means
const schema = defineSchema({
  partitions: { org: {} },
  roles: { org: ["owner", "dispatcher", "tech", "viewer"] },
  tables: {
    jobs: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        status: t.text(),
        assignee: t.text().nullable(),
        rank: t.integer(),
      },
      partition: "org",
      allow: ({ role, owner, anyOf }) => ({
        $default: role("tech"),
        read: anyOf(role("dispatcher"), owner("assignee")),
        update: role("dispatcher"),
      }),
    },
  },
});

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();

const tag = <E extends { _tag: string }>(r: { isErr: () => boolean; error?: E }) =>
  // SAFETY: test helper; error is present exactly when isErr()
  r.isErr() ? (r as { error: E }).error._tag : "ok";

/** An authority-shaped process: ungranted validator (schema only), tables on one SQLite connection. */
const open = async (as?: Principal) => {
  const driver = bunSqliteDriver(":memory:");
  const stores = (await openStores(driver, { tables: [schema.tables.jobs] })).unwrap();
  const validate = createValidator({ schema, grantFor: null });
  const engine = (
    await openEngine({
      peerId: device.peerId,
      clock: createHlcClock({ now: () => T0 }),
      store: stores.events,
      stateStore: stores.state,
      validate,
    })
  ).unwrap();
  const base = { engine, validate, driver, schema, partition: ACME };
  const mesh = meshDrizzle(as === undefined ? base : { ...base, as });
  return { ...mesh, engine, stores, driver };
};

const dispatcher: Principal = { account: "acct_d", role: "dispatcher", claims: {} };
const tech7: Principal = { account: "tech7", role: "tech", claims: {} };
const viewer: Principal = { account: "acct_v", role: "viewer", claims: {} };

describe("Drizzle over a mesh", () => {
  test("a statement is an event: insert, update, delete each captured with the partition stamped", async () => {
    const { db, stores, driver } = await open();
    await db.insert(jobs).values({ id: "j1", title: "panel B", status: "open", rank: 1 });
    await db.update(jobs).set({ status: "assigned", assignee: "tech7" }).where(eq(jobs.id, "j1"));
    await db.delete(jobs).where(eq(jobs.id, "j1"));
    const events = (await stores.events.all()).unwrap().map((e) => e.event);
    expect(events.map((e) => String(e.procedure))).toEqual([
      "jobs.insert",
      "jobs.update",
      "jobs.delete",
    ]);
    expect(events.map((e) => e.changes[0]?.kind)).toEqual(["insert", "update", "delete"]);
    const update = events[1]?.changes[0];
    expect(update?.kind === "update" && [...update.patch.keys()].map(String).sort()).toEqual([
      "assignee",
      "status",
    ]);
    expect(String(events[0]?.partition)).toBe("org:acme");
    expect((await driver.all(`SELECT COUNT(*) FROM jobs`))[0]?.[0]).toBe(0);
  });

  test("write(): several statements, one labelled event, the value returned", async () => {
    const { write, stores } = await open();
    const out = (
      await write("jobs.seed", async (tx) => {
        await tx.insert(jobs).values({ id: "j1", title: "one", status: "open", rank: 1 });
        await tx.insert(jobs).values({ id: "j2", title: "two", status: "open", rank: 2 });
        await tx.update(jobs).set({ rank: 3 }).where(eq(jobs.id, "j1"));
        return (await tx.select().from(jobs)).length;
      })
    ).unwrap();
    expect(out.value).toBe(2);
    const events = (await stores.events.all()).unwrap().map((e) => e.event);
    expect(events).toHaveLength(1);
    expect(String(events[0]?.procedure)).toBe("jobs.seed");
    expect(events[0]?.changes.map((c) => `${c.kind}:${String(c.key)}`)).toEqual([
      "insert:j1",
      "insert:j2",
    ]);
    expect(String(events[0]?.id)).toBe(out.eventId);
    // j1's insert carries the final rank, since the two statements are one change
    const j1 = events[0]?.changes[0];
    // SAFETY: test fixture — the column name the statement set; names are brands over these strings
    expect(j1?.kind === "insert" && j1.row.get("rank" as never)).toBe(3);
  });

  test("read(): the source a principal sees — dispatchers all, a tech their own, a viewer nothing", async () => {
    const seeded = await open();
    await seeded.db.insert(jobs).values([
      { id: "j1", title: "one", status: "open", rank: 1, assignee: "tech7" },
      { id: "j2", title: "two", status: "open", rank: 2, assignee: "tech8" },
    ]);
    const rows = async (as: Principal) => {
      const { db, read } = meshDrizzle({
        engine: seeded.engine,
        validate: createValidator({ schema, grantFor: null }),
        driver: seeded.driver,
        schema,
        partition: ACME,
        as,
      });
      const j = read(jobs);
      return (await db.select({ id: j.id }).from(j).orderBy(j.id)).map((r) => r.id);
    };
    expect(await rows(dispatcher)).toEqual(["j1", "j2"]);
    expect(await rows(tech7)).toEqual(["j1"]);
    expect(await rows(viewer)).toEqual([]);
  });

  test("acting as a caller, a write their rules deny is refused before COMMIT", async () => {
    const seeded = await open();
    await seeded.db
      .insert(jobs)
      .values({ id: "j1", title: "one", status: "open", rank: 1, assignee: "tech7" });
    const asTech = await open(tech7);
    // same connection semantics on a fresh process is not the point; act as tech7 over the seeded tables
    const { write } = meshDrizzle({
      engine: seeded.engine,
      validate: createValidator({ schema, grantFor: null }),
      driver: seeded.driver,
      schema,
      partition: ACME,
      as: tech7,
    });
    const denied = await write("jobs.rename", (tx) =>
      tx.update(jobs).set({ title: "mine" }).where(eq(jobs.id, "j1")),
    );
    expect(tag(denied)).toBe("PolicyDenied");
    expect((await seeded.driver.all(`SELECT title FROM jobs`))[0]?.[0]).toBe("one");
    expect((await seeded.stores.events.all()).unwrap()).toHaveLength(1);
    void asTech;
  });

  test("live(): re-runs after a fold touched its table, notifies once per batch, only on change", async () => {
    const { db, read, live } = await open(dispatcher);
    const j = read(jobs);
    const openJobs = live(
      db.select({ id: j.id }).from(j).where(eq(j.status, "open")).orderBy(j.id),
    );
    expect(await openJobs.ready).toEqual([]);
    let notified = 0;
    openJobs.subscribe(() => void (notified += 1));

    await db.insert(jobs).values({ id: "j1", title: "one", status: "open", rank: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(openJobs.data()?.map((r) => r.id)).toEqual(["j1"]);
    expect(notified).toBe(1);

    await db.update(jobs).set({ title: "one!" }).where(eq(jobs.id, "j1")); // touches the table, result unchanged
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(notified).toBe(1);

    await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, "j1"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(openJobs.data()).toEqual([]);
    expect(notified).toBe(2);
    openJobs.release();
  });
});

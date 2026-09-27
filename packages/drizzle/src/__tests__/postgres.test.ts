import type { Principal } from "@syncmesh/engine";

import { PGlite } from "@electric-sql/pglite";
import { createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { pgliteDriver } from "@syncmesh/postgres";
import { defineSchema, t } from "@syncmesh/schema";
import { installRls, openStores } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

import { meshDrizzle } from "../index.js";

// the app's table, as Drizzle knows it …
const jobs = pgTable("jobs", {
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
      allow: ({ role, owner, any }) => ({
        $default: role("tech"),
        read: any(role("dispatcher"), owner("assignee")),
        update: role("dispatcher"),
      }),
    },
  },
});

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();

/** Drizzle wraps a proxy failure as DrizzleQueryError; the mesh's tagged error rides on `cause`. */
const causeTag = (thrown: Error | string): string => {
  let current: unknown = thrown;
  while (current instanceof Error) {
    // SAFETY: reading an optional discriminant off an Error; absent on plain errors, the walk continues
    const tagged = current as Error & { readonly _tag?: string };
    if (tagged._tag !== undefined) return tagged._tag;
    current = current.cause;
  }
  return String(thrown);
};

/** An authority: ungranted validator (schema only), tables in its own Postgres — here PGlite, in-process. */
const open = async (as?: Principal) => {
  const driver = pgliteDriver(new PGlite());
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

describe("Drizzle over a mesh — the Postgres face", () => {
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
    expect(Number((await driver.all(`SELECT COUNT(*) FROM jobs`))[0]?.[0])).toBe(0);
  });

  test("db.transaction(): several statements, one event, the value returned; read-only is no event", async () => {
    const { db, stores } = await open();
    const count = await db.transaction(async (tx) => {
      await tx.insert(jobs).values({ id: "j1", title: "one", status: "open", rank: 1 });
      await tx.insert(jobs).values({ id: "j2", title: "two", status: "open", rank: 2 });
      await tx.update(jobs).set({ rank: 3 }).where(eq(jobs.id, "j1"));
      return (await tx.select().from(jobs)).length;
    });
    expect(count).toBe(2);
    const events = (await stores.events.all()).unwrap().map((e) => e.event);
    expect(events).toHaveLength(1);
    expect(String(events[0]?.procedure)).toBe("jobs.insert");
    expect(events[0]?.changes.map((c) => `${c.kind}:${String(c.key)}`)).toEqual([
      "insert:j1",
      "insert:j2",
    ]);
    const j1 = events[0]?.changes[0];
    // SAFETY: test fixture — the column name the statement set; names are brands over these strings
    expect(j1?.kind === "insert" && j1.row.get("rank" as never)).toBe(3);

    const titles = await db.transaction((tx) => tx.select({ id: jobs.id }).from(jobs));
    expect(titles).toHaveLength(2);
    expect((await stores.events.all()).unwrap()).toHaveLength(1); // read-only: no event

    await db.transaction(async (tx) => {
      await tx.update(jobs).set({ status: "done" }).where(eq(jobs.id, "j1"));
      await tx.delete(jobs).where(eq(jobs.id, "j2"));
    });
    expect(String((await stores.events.all()).unwrap().at(-1)?.event.procedure)).toBe(
      "jobs.update+jobs.delete",
    );
  });

  test("db.transaction(): a thrown callback rolls everything back — no rows, no event", async () => {
    const { db, stores, driver } = await open();
    const failed = await db
      .transaction(async (tx) => {
        await tx.insert(jobs).values({ id: "j1", title: "one", status: "open", rank: 1 });
        throw new Error("changed my mind");
      })
      .then(
        () => "resolved",
        (cause: unknown) => String(cause),
      );
    expect(failed).toContain("changed my mind");
    expect(Number((await driver.all(`SELECT COUNT(*) FROM jobs`))[0]?.[0])).toBe(0);
    expect((await stores.events.all()).unwrap()).toHaveLength(0);
  });

  test("a nested tx.transaction() is refused and the outer one rolls back — no savepoint reaches the capture", async () => {
    const { db, stores, driver } = await open();
    const failed = await db
      .transaction(async (tx) => {
        await tx.insert(jobs).values({ id: "j1", title: "one", status: "open", rank: 1 });
        await tx.transaction(async (inner) => {
          await inner.insert(jobs).values({ id: "j2", title: "two", status: "open", rank: 2 });
        });
      })
      .then(
        () => "resolved",
        (cause: unknown) => String(cause),
      );
    expect(failed).toContain("Transactions are not supported");
    expect(Number((await driver.all(`SELECT COUNT(*) FROM jobs`))[0]?.[0])).toBe(0);
    expect((await stores.events.all()).unwrap()).toHaveLength(0);
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
    const asTech = meshDrizzle({
      engine: seeded.engine,
      validate: createValidator({ schema, grantFor: null }),
      driver: seeded.driver,
      schema,
      partition: ACME,
      as: tech7,
    });
    const denied = await asTech.db
      .transaction((tx) => tx.update(jobs).set({ title: "mine" }).where(eq(jobs.id, "j1")))
      .then(
        () => "resolved",
        (cause: unknown) => causeTag(cause instanceof Error ? cause : String(cause)),
      );
    expect(denied).toBe("PolicyDenied");
    expect((await seeded.driver.all(`SELECT title FROM jobs`))[0]?.[0]).toBe("one");
    expect((await seeded.stores.events.all()).unwrap()).toHaveLength(1);
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

describe("RLS through the face — read() retired at the call site", () => {
  test("with installRls, a plain db.select() is the caller's view: bare reads, transactions and writes alike", async () => {
    const seeded = await open();
    await seeded.db.insert(jobs).values([
      { id: "j1", title: "one", status: "open", rank: 1, assignee: "tech7" },
      { id: "j2", title: "two", status: "open", rank: 2, assignee: "tech8" },
    ]);
    (await installRls(seeded.driver, schema)).unwrap();
    // superusers are outside RLS by Postgres's own rules: the app reads through a plain role
    await seeded.driver.run(`CREATE ROLE syncmesh_app NOLOGIN`);
    await seeded.driver.run(`GRANT USAGE ON SCHEMA public TO syncmesh_app`);
    await seeded.driver.run(`GRANT ALL ON ALL TABLES IN SCHEMA public TO syncmesh_app`);
    await seeded.driver.run(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO syncmesh_app`);
    await seeded.driver.run(`SET ROLE syncmesh_app`);

    const handleFor = (as: Principal) =>
      meshDrizzle({
        engine: seeded.engine,
        validate: createValidator({ schema, grantFor: null }),
        driver: seeded.driver,
        schema,
        partition: ACME,
        as,
      });
    const ids = async (as: Principal) =>
      (await handleFor(as).db.select({ id: jobs.id }).from(jobs).orderBy(jobs.id)).map((r) => r.id);

    expect(await ids(dispatcher)).toEqual(["j1", "j2"]); // no read() anywhere in sight
    expect(await ids(tech7)).toEqual(["j1"]);
    expect(await ids(viewer)).toEqual([]);

    // the same view inside the caller's transaction, and the write within it still lands
    const asDispatcher = handleFor(dispatcher);
    const seen = await asDispatcher.db.transaction(async (tx) => {
      await tx.update(jobs).set({ status: "assigned" }).where(eq(jobs.id, "j1"));
      return (await tx.select({ id: jobs.id }).from(jobs)).length;
    });
    expect(seen).toBe(2);
    expect(await ids(tech7)).toEqual(["j1"]); // and tech7 still sees only their own

    await seeded.driver.run(`RESET ROLE`);
  });
});

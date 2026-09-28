import type { Principal } from "@syncmesh/engine";

import { createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { openStores } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { meshDrizzle, readOnly, scopeReads } from "../index.js";

// the app's table, as Drizzle knows it …
const jobs = sqliteTable("jobs", {
  id: text().primaryKey(),
  title: text().notNull(),
  status: text().notNull(),
  assignee: text(),
  rank: integer().notNull(),
});

// … and what syncing it means
const org = partition("org", { roles: ladder("owner", "dispatcher", "tech", "viewer") });
const schema = syncSchema({
  tables: {
    jobs: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        status: t.text(),
        assignee: t.text().nullable(),
        rank: t.integer(),
      },
      partition: org,
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
    expect((await driver.all(`SELECT COUNT(*) FROM jobs`))[0]?.[0]).toBe(0);
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

/**
 * The pair this replaces was a `db` that saw the whole replica and a `read()` the handler had to
 * remember to wrap each table in. On Postgres with `rls: true` the database scoped reads anyway,
 * so forgetting `read()` was only unsafe on devices — which is to say, in the place no
 * server-side test looks.
 */
describe("scopeReads — the caller's view without asking for it", () => {
  const acting = async (seeded: Awaited<ReturnType<typeof open>>, as: Principal) =>
    meshDrizzle({
      engine: seeded.engine,
      validate: createValidator({ schema, grantFor: null }),
      driver: seeded.driver,
      schema,
      partition: ACME,
      as,
    });

  const seedTwo = async () => {
    const seeded = await open();
    await seeded.db.insert(jobs).values([
      { id: "j1", title: "one", status: "open", rank: 1, assignee: "tech7" },
      { id: "j2", title: "two", status: "open", rank: 2, assignee: "tech8" },
    ]);
    return seeded;
  };

  test("a bare table in `from` is the scoped source — same rows `read()` returned by hand", async () => {
    const seeded = await seedTwo();
    const rows = async (as: Principal) => {
      const face = await acting(seeded, as);
      const db = scopeReads(face.db, face.read);
      return (await db.select({ id: jobs.id }).from(jobs).orderBy(jobs.id)).map((r) => r.id);
    };
    expect(await rows(dispatcher)).toEqual(["j1", "j2"]);
    expect(await rows(tech7)).toEqual(["j1"]);
    expect(await rows(viewer)).toEqual([]);
  });

  test("the substitution survives a where and an order by, which is where a handler puts its filters", async () => {
    const seeded = await seedTwo();
    const face = await acting(seeded, tech7);
    const db = scopeReads(face.db, face.read);
    const rows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.status, "open"))
      .orderBy(jobs.id);
    // j2 is open too, and belongs to tech8: the caller's rule removes it, not the where clause
    expect(rows.map((r) => r.id)).toEqual(["j1"]);
  });

  test("a source that is already a subquery is passed through, not scoped twice", async () => {
    const seeded = await seedTwo();
    const face = await acting(seeded, dispatcher);
    const db = scopeReads(face.db, face.read);
    const inner = db.select({ id: jobs.id }).from(jobs).as("inner");
    expect(
      (await db.select({ id: inner.id }).from(inner).orderBy(inner.id)).map((r) => r.id),
    ).toEqual(["j1", "j2"]);
  });

  test("writes go through unscoped: the rule is about what a caller reads, not what capture sees", async () => {
    const seeded = await open();
    const db = scopeReads(seeded.db, seeded.read);
    await db.insert(jobs).values({ id: "j9", title: "nine", status: "open", rank: 9 });
    expect((await seeded.db.select({ id: jobs.id }).from(jobs)).map((r) => r.id)).toEqual(["j9"]);
  });
});

describe("readOnly — a query body cannot write", () => {
  test("the write verbs are absent, so a cast reaches nothing", async () => {
    const seeded = await open();
    const db = readOnly(scopeReads(seeded.db, seeded.read));
    for (const verb of ["insert", "update", "delete", "transaction"])
      expect(verb in db).toBe(false);
  });

  test("selecting still works — subtraction, not a different object", async () => {
    const seeded = await open();
    await seeded.db.insert(jobs).values({ id: "j1", title: "one", status: "open", rank: 1 });
    const db = readOnly(scopeReads(seeded.db, seeded.read));
    expect((await db.select({ id: jobs.id }).from(jobs)).map((r) => r.id)).toEqual(["j1"]);
  });
});

import { createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { openStores } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { meshDrizzle } from "../index.js";

const jobs = sqliteTable("jobs", { id: text().primaryKey(), title: text().notNull() });
const org = partition("org", { roles: ladder("member") });
const schema = syncSchema({
  tables: {
    jobs: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: org,
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 70 + i)).unwrap();
const SEEN = "panel B (seen)";

/** One handle over one SQLite connection, with the row the panel is showing already in it. */
const open = async () => {
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
  const mesh = meshDrizzle({ engine, validate, driver, schema, partition: ACME });
  await mesh.db.insert(jobs).values({ id: "j1", title: "panel B" });
  return { ...mesh, stores, driver };
};

type Opened = Awaited<ReturnType<typeof open>>;

/** The procedure label of every event the log holds, oldest first. */
const ledger = async (mesh: Opened) =>
  (await mesh.stores.events.all()).unwrap().map((e) => String(e.event.procedure));

/** The detail panel's `remove.can(…)`: a rehearsed delete that stays open until `letGo` is called. */
const rehearseDelete = (mesh: Opened) => {
  let letGo!: () => void;
  const holding = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  // through the span, as a handler does: the rehearsal's transaction admits that sink and no other
  const verdict = mesh.rehearse(async (span) => {
    await span.db.delete(jobs).where(eq(jobs.id, "j1"));
    await holding;
  });
  return { verdict, letGo };
};

/**
 * The panel's own `issues.get`: a bare `SELECT`, fired at the handle from beside whatever else is
 * open on it. Started rather than awaited, so the read is in flight while the rest of the test runs.
 */
const readJob = (mesh: Opened) => mesh.db.select().from(jobs).where(eq(jobs.id, "j1")).execute();

/** The view bump the same panel fires when it opens: an ordinary write on the same handle. */
const bumpView = (mesh: Opened) =>
  mesh.db.transaction((tx) => tx.update(jobs).set({ title: SEEN }).where(eq(jobs.id, "j1")));

/**
 * An ordinary write transaction, held open and then **thrown out of**, so its `UPDATE` is a value
 * nothing ever commits: a read that comes back with it read something that never happened.
 */
const failingWrite = (mesh: Opened) => {
  let letGo!: () => void;
  const holding = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  const done = mesh.db
    .transaction(async (tx) => {
      await tx.update(jobs).set({ title: SEEN }).where(eq(jobs.id, "j1"));
      await holding;
      throw new Error("the handler fell over");
    })
    .then(
      () => undefined,
      () => undefined,
    );
  return { done, letGo };
};

const turn = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("a rehearsal has the handle to itself", () => {
  test("a rehearsal and a write started in the same tick both settle, and the row survives", async () => {
    const mesh = await open();
    const { verdict, letGo } = rehearseDelete(mesh);
    const bumped = bumpView(mesh);
    await turn();
    letGo();
    const [rehearsed] = await Promise.all([verdict, bumped]);

    expect(rehearsed.isOk()).toBe(true);
    expect(await mesh.driver.all(`SELECT id, title FROM jobs`)).toEqual([["j1", SEEN]]);
    // the rehearsed delete was never an event, and never rode one either
    expect(await ledger(mesh)).toEqual(["jobs.insert", "jobs.update"]);
  });

  test("a write that arrives while a rehearsal is open is a write, not a casualty of its rollback", async () => {
    const mesh = await open();
    const { verdict, letGo } = rehearseDelete(mesh);
    await turn(); // the rehearsal's transaction is open and holding the handle
    const bumped = bumpView(mesh);
    await turn();
    letGo();
    await Promise.all([verdict, bumped]);

    // the bump commits as itself: neither judged as part of the rehearsal nor rolled back with it
    expect(await mesh.driver.all(`SELECT id, title FROM jobs`)).toEqual([["j1", SEEN]]);
    expect(await ledger(mesh)).toEqual(["jobs.insert", "jobs.update"]);
  });

  test("a bare write fired beside a rehearsal commits as itself, rather than being rolled away", async () => {
    const mesh = await open();
    const { verdict, letGo } = rehearseDelete(mesh);
    await turn(); // the rehearsal's transaction is open and holding the handle
    const bare = mesh.db.update(jobs).set({ title: SEEN }).where(eq(jobs.id, "j1"));
    await turn();
    letGo();
    await Promise.all([bare, verdict]);

    // a statement with no transaction of its own used to join the rehearsal's and roll back
    // inside it: the write was lost, and there was no event to say a write had been attempted
    expect(await mesh.driver.all(`SELECT id, title FROM jobs`)).toEqual([["j1", SEEN]]);
    expect(await ledger(mesh)).toEqual(["jobs.insert", "jobs.update"]);
  });

  test("a read taken while a rehearsal is open sees the committed row, not the staged delete", async () => {
    const mesh = await open();
    const { verdict, letGo } = rehearseDelete(mesh);
    await turn(); // the rehearsed DELETE has run and is staged, and nothing has rolled back yet
    const during = readJob(mesh);
    await turn();
    letGo();
    const [rows] = await Promise.all([during, verdict]);

    // the row exists, is never deleted, and a read beside the rehearsal must say so
    expect(rows).toEqual([{ id: "j1", title: "panel B" }]);
  });

  test("two rehearsals started in the same tick both settle", async () => {
    const mesh = await open();
    const first = rehearseDelete(mesh);
    const second = rehearseDelete(mesh);
    first.letGo();
    second.letGo();
    const both = await Promise.all([first.verdict, second.verdict]);

    expect(both.map((verdict) => verdict.isOk())).toEqual([true, true]);
    expect(await mesh.driver.all(`SELECT id FROM jobs`)).toEqual([["j1"]]);
    expect(await ledger(mesh)).toEqual(["jobs.insert"]);
  });
});

/**
 * The same hazard with the constant thing on the other side of it: a rehearsal is rare and a write
 * is not, so a read that joins whatever transaction is open is answered out of uncommitted rows
 * far more often than the panel bug that found it.
 */
describe("a read is not a transaction, and joins nobody else's", () => {
  test("a read taken while a write is open sees the committed row, not the uncommitted one", async () => {
    const mesh = await open();
    const { done, letGo } = failingWrite(mesh);
    await turn(); // the UPDATE has run and is uncommitted
    const during = readJob(mesh);
    await turn();
    letGo();
    const [rows] = await Promise.all([during, done]);

    // the title the read could have come back with was rolled away and never existed
    expect(rows).toEqual([{ id: "j1", title: "panel B" }]);
    expect(await mesh.driver.all(`SELECT id, title FROM jobs`)).toEqual([["j1", "panel B"]]);
    expect(await ledger(mesh)).toEqual(["jobs.insert"]);
  });
});

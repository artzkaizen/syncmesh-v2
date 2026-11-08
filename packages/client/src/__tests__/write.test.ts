import type { SyncEvent } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { createMemoryEventStore, createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey, readRow } from "@syncmesh/kernel";
import { ladder, local, partition, syncSchema, t, user } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { installCapture } from "@syncmesh/storage";
import { createWriter } from "@syncmesh/storage";
import { asFold } from "@syncmesh/storage/driver-tests";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, verifyGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

const org = partition("org", { roles: ladder("dispatcher", "viewer") });
const schema = syncSchema({
  tables: {
    jobs: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        rank: t.integer(),
        assignee: t.text().nullable(),
      },
      partition: org,
      allow: ({ role }) => ({ $default: role("viewer"), update: role("dispatcher") }),
    },
    drafts: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: local },
  },
});
const tables = [schema.tables.jobs, schema.tables.drafts];

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();

const tag = <E extends { _tag: string }>(r: { isErr: () => boolean; error?: E }) =>
  // SAFETY: test helper; error is present exactly when isErr()
  r.isErr() ? (r as { error: E }).error._tag : "ok";

/** A device with the app's tables on a SQLite connection and an engine over a memory log. */
const setup = async (role?: string) => {
  const driver = bunSqliteDriver(":memory:");
  (await installCapture(driver, tables)).unwrap();
  const grant: Grant | undefined =
    role === undefined
      ? undefined
      : verifyGrant(
          issueGrant(issuer, {
            account: "acct_a",
            device: device.peerId,
            role,
            // SAFETY: test fixture instance in the documented kind:id form
            partitions: ["org:acme"] as never,
            validFor: Temporal.Duration.from({ hours: 1 }),
            now: T0,
          }),
          issuer.peerId,
          T0,
        ).unwrap();
  const validate = createValidator({
    schema,
    grantFor: grant === undefined ? null : () => grant,
  });
  const store = createMemoryEventStore();
  const engine = (
    await openEngine({
      peerId: device.peerId,
      clock: createHlcClock({ now: () => T0 }),
      store,
      validate,
    })
  ).unwrap();
  const write = createWriter({ engine, validate, driver, tables, schema });
  const count = async () => Number((await driver.all(`SELECT COUNT(*) FROM jobs`))[0]?.[0]);
  return { driver, engine, store, write, count };
};

describe("write — the app's SQL transaction becomes one event", () => {
  test("two statements, one event; the engine's state and the table agree", async () => {
    const { driver, engine, store, write, count } = await setup();
    const receipt = (
      await write(
        "jobs.seed",
        async () => {
          await driver.run(`INSERT INTO jobs (id, title, rank) VALUES ('j1', 'one', 1)`);
          await driver.run(`UPDATE jobs SET title = 'one!' WHERE id = 'j1'`);
        },
        { partition: ACME },
      )
    ).unwrap();
    const events = (await store.all()).unwrap();
    expect(events).toHaveLength(1);
    expect(events[0]?.event.id).toBe(receipt.eventId);
    // one stamp per event, so the row's two statements are one change: the insert, as it ended up
    expect(events[0]?.event.changes.map((c) => c.kind)).toEqual(["insert"]);
    expect(events[0]?.event.partition).toBe(ACME);
    // SAFETY: test fixture — the key text the INSERT above used; keys are opaque strings in the kernel
    const row = readRow(engine.state(), schema.tables.jobs.name, "j1" as never);
    expect(row?.get(schema.tables.jobs.columnNames.title)).toBe("one!");
    expect(await count()).toBe(1);
    // the app's INSERT named no partition; the write's stamped it on the row it inserted
    expect((await driver.all(`SELECT _partition FROM jobs`))[0]?.[0]).toBe("org:acme");
  });

  test("a schema violation rolls the SQL back: no row, no event", async () => {
    const { driver, store, write, count } = await setup();
    const r = await write(
      "jobs.bad",
      () => driver.run(`INSERT INTO jobs (id, title, rank) VALUES ('j1', 'one', 'not a number')`),
      { partition: ACME },
    );
    expect(tag(r)).toBe("SchemaViolation");
    expect(await count()).toBe(0);
    expect((await store.all()).unwrap()).toHaveLength(0);
  });

  test("policy runs before COMMIT: a viewer's update is refused and rolled back; a dispatcher's lands", async () => {
    const viewer = await setup("viewer");
    (
      await viewer.write(
        "jobs.create",
        () => viewer.driver.run(`INSERT INTO jobs (id, title, rank) VALUES ('j1', 'one', 1)`),
        { partition: ACME },
      )
    ).unwrap();
    const denied = await viewer.write(
      "jobs.rename",
      () => viewer.driver.run(`UPDATE jobs SET title = 'mine now' WHERE id = 'j1'`),
      { partition: ACME },
    );
    expect(tag(denied)).toBe("PolicyDenied");
    expect((await viewer.driver.all(`SELECT title FROM jobs`))[0]?.[0]).toBe("one");
    expect((await viewer.store.all()).unwrap()).toHaveLength(1);

    const dispatcher = await setup("dispatcher");
    (
      await dispatcher.write(
        "jobs.create",
        () => dispatcher.driver.run(`INSERT INTO jobs (id, title, rank) VALUES ('j1', 'one', 1)`),
        { partition: ACME },
      )
    ).unwrap();
    expect(
      tag(
        await dispatcher.write(
          "jobs.assign",
          () => dispatcher.driver.run(`UPDATE jobs SET assignee = 'tech7' WHERE id = 'j1'`),
          { partition: ACME },
        ),
      ),
    ).toBe("ok");
    expect((await dispatcher.store.all()).unwrap().at(-1)?.event.changes[0]?.kind).toBe("update");
  });

  test("a transaction that changes nothing is EmptyMutation, and a no-op UPDATE counts as nothing", async () => {
    const { driver, write } = await setup();
    expect(tag(await write("jobs.noop", () => Promise.resolve(), { partition: ACME }))).toBe(
      "EmptyMutation",
    );
    (
      await write(
        "jobs.create",
        () => driver.run(`INSERT INTO jobs (id, title, rank) VALUES ('j1', 'one', 1)`),
        { partition: ACME },
      )
    ).unwrap();
    expect(
      tag(
        await write(
          "jobs.same",
          () => driver.run(`UPDATE jobs SET title = 'one' WHERE id = 'j1'`),
          {
            partition: ACME,
          },
        ),
      ),
    ).toBe("EmptyMutation");
  });
});

describe("the fold writes the same tables", () => {
  test("a peer's event lands in this device's SQL table with the guard at rest; its own write is still captured", async () => {
    const a = await setup();
    (
      await a.write(
        "jobs.create",
        () => a.driver.run(`INSERT INTO jobs (id, title, rank) VALUES ('j1', 'from a', 1)`),
        { partition: ACME },
      )
    ).unwrap();

    // b: the same tables, projected by the fold (openStores installs capture and the projection)
    const bDriver = bunSqliteDriver(":memory:");
    const { openStores } = await import("@syncmesh/storage");
    const bStores = (await openStores(bDriver, { tables })).unwrap();
    const bKey = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 140 + i)).unwrap();
    const validate = createValidator({ schema, grantFor: null });
    const b = (
      await openEngine({
        peerId: bKey.peerId,
        clock: createHlcClock({ now: () => T0 }),
        store: bStores.events,
        stateStore: bStores.state,
        validate,
      })
    ).unwrap();
    (await b.receiveBatch((await a.store.all()).unwrap())).unwrap();
    expect((await bDriver.all(`SELECT title, _partition FROM jobs`))[0]).toEqual([
      "from a",
      "org:acme",
    ]);
    expect(Number((await bDriver.all(`SELECT COUNT(*) FROM syncmesh_changes`))[0]?.[0])).toBe(0);

    const writeB = createWriter({ engine: b, validate, driver: bDriver, tables });
    (
      await writeB(
        "jobs.rename",
        () => bDriver.run(`UPDATE jobs SET title = 'from b' WHERE id = 'j1'`),
        { partition: ACME },
      )
    ).unwrap();
    const last = (await bStores.events.all()).unwrap().at(-1)?.event;
    expect(String(last?.peerId)).toBe(String(bKey.peerId));
    expect(last?.changes[0]?.kind).toBe("update");
    // SAFETY: test fixture — the key text the INSERT used; keys are opaque strings in the kernel
    const bRow = readRow(b.state(), schema.tables.jobs.name, "j1" as never);
    expect(bRow?.get(schema.tables.jobs.columnNames.title)).toBe("from b");
  });
});

describe("locality is the schema's", () => {
  test("a transaction wholly on a local table is a local event: stored, folded, never outbound", async () => {
    const { driver, engine, store, write } = await setup();
    const outbound: SyncEvent[] = [];
    engine.onOutbound((e) => void outbound.push(e));
    const receipt = (
      await write("drafts.insert", () =>
        driver.run(`INSERT INTO drafts (id, body) VALUES ('d1', 'wip')`),
      )
    ).unwrap();
    const events = (await store.all()).unwrap();
    expect(events).toHaveLength(1);
    expect(events[0]?.event.local).toBe(true);
    expect(events[0]?.event.id).toBe(receipt.eventId);
    expect(outbound).toHaveLength(0);
    expect((await driver.all(`SELECT body FROM drafts`))[0]?.[0]).toBe("wip");
  });

  test("mixing a local and a synced table in one transaction is LocalOnly: everything rolls back", async () => {
    const { driver, store, write, count } = await setup();
    const r = await write(
      "mixed",
      async () => {
        await driver.run(`INSERT INTO jobs (id, title, rank) VALUES ('j1', 'one', 1)`);
        await driver.run(`INSERT INTO drafts (id, body) VALUES ('d1', 'wip')`);
      },
      { partition: ACME },
    );
    expect(tag(r)).toBe("LocalOnly");
    expect(await count()).toBe(0);
    expect(Number((await driver.all(`SELECT COUNT(*) FROM drafts`))[0]?.[0])).toBe(0);
    expect((await store.all()).unwrap()).toHaveLength(0);
  });
});

describe("a retired column (D31) through change capture", () => {
  /** v2 retired `owner`: still a column in SQL, read and folded, never written here. */
  const retiring = syncSchema({
    schemaVersion: 2,
    tables: {
      notes: {
        columns: {
          id: t.text().primaryKey(),
          body: t.text(),
          owner: t.text().nullable().retired(),
        },
        partition: user,
      },
    },
  });
  const notes = [retiring.tables.notes];
  const USER = parsePartitionKey("user:acct_a").unwrap();
  const OWNER = retiring.tables.notes.columnNames.owner;
  const author = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 170 + i)).unwrap();

  const device = async () => {
    const driver = bunSqliteDriver(":memory:");
    (await installCapture(driver, notes)).unwrap();
    const validate = createValidator({ schema: retiring, grantFor: null });
    const store = createMemoryEventStore();
    const engine = (
      await openEngine({
        peerId: author.peerId,
        clock: createHlcClock({ now: () => T0 }),
        store,
        validate,
      })
    ).unwrap();
    const write = createWriter({ engine, validate, driver, tables: notes, schema: retiring });
    const lastChange = async () => (await store.all()).unwrap().at(-1)?.event.changes[0];
    return { driver, write, lastChange };
  };

  test("an INSERT that never names it is no write to it, and is not refused", async () => {
    const { driver, write, lastChange } = await device();
    const r = await write(
      "notes.add",
      () => driver.run(`INSERT INTO notes (id, body) VALUES ('n1', 'one')`),
      { partition: USER },
    );
    expect(tag(r)).toBe("ok");
    const change = await lastChange();
    expect(change?.kind).toBe("insert");
    // the SQL row image holds `owner: null`; the event must not carry it
    expect(change?.kind === "insert" && change.row.has(OWNER)).toBe(false);
  });

  test("an INSERT that sets it is still RetiredWrite, and rolls back", async () => {
    const { driver, write } = await device();
    const r = await write(
      "notes.add",
      () => driver.run(`INSERT INTO notes (id, body, owner) VALUES ('n1', 'one', 'ada')`),
      { partition: USER },
    );
    expect(tag(r)).toBe("RetiredWrite");
    expect((await driver.all(`SELECT COUNT(*) FROM notes`))[0]?.[0]).toBe(0);
  });

  test("a row deleted and inserted again without it keeps the old build's value out of the patch", async () => {
    const { driver, write, lastChange } = await device();
    // the row as an older build's fold left it, before this transaction: not captured
    await asFold(driver, () =>
      driver.run(`INSERT INTO notes (id, body, owner) VALUES ('n1', 'one', 'ada')`),
    );
    const r = await write(
      "notes.redo",
      async () => {
        await driver.run(`DELETE FROM notes WHERE id = 'n1'`);
        await driver.run(`INSERT INTO notes (id, body) VALUES ('n1', 'again')`);
      },
      { partition: USER },
    );
    expect(tag(r)).toBe("ok");
    const change = await lastChange();
    expect(change?.kind === "update" && [...change.patch.keys()].map(String)).toEqual(["body"]);
  });
});

import type { Grant } from "@syncmesh/wire";

import { createMemoryEventStore, createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey, readRow } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { installCapture } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, verifyGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createWriter } from "../write.js";

const schema = defineSchema({
  partitions: { org: {} },
  roles: { org: ["dispatcher", "viewer"] },
  tables: {
    jobs: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        rank: t.integer(),
        assignee: t.text().nullable(),
      },
      partition: "org",
      allow: ({ role }) => ({ $default: role("viewer"), update: role("dispatcher") }),
    },
  },
});
const tables = [schema.tables.jobs];

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
  const write = createWriter({ engine, validate, driver, tables });
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
    expect(String(events[0]?.event.id)).toBe(String(receipt.eventId));
    // one stamp per event, so the row's two statements are one change: the insert, as it ended up
    expect(events[0]?.event.changes.map((c) => c.kind)).toEqual(["insert"]);
    expect(String(events[0]?.event.partition)).toBe("org:acme");
    // SAFETY: test fixture — the key text the INSERT above used; keys are opaque strings in the kernel
    const row = readRow(engine.state(), schema.tables.jobs.name, "j1" as never);
    expect(row?.get(schema.tables.jobs.columnNames.title)).toBe("one!");
    expect(await count()).toBe(1);
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

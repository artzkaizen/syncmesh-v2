import { createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { openStores } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { meshDrizzle } from "../index.js";

const jobs = sqliteTable("jobs", { id: text().primaryKey(), title: text().notNull() });
const schema = syncSchema({
  partitions: { org: {} },
  roles: { org: ["member"] },
  tables: {
    jobs: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: "org",
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 40 + i)).unwrap();

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
  return meshDrizzle({ engine, validate, driver, schema, partition: ACME });
};

describe("live queries asking the same question share one run", () => {
  const listing = (mesh: Awaited<ReturnType<typeof open>>) =>
    mesh.db.select({ id: jobs.id }).from(jobs).orderBy(asc(jobs.id));

  test("the same SQL and binds get one subscription; a different filter does not", async () => {
    const mesh = await open();
    const a = mesh.live(listing(mesh));
    const b = mesh.live(listing(mesh));
    await Promise.all([a.ready, b.ready]);

    // one underlying query: both consumers see the same cached snapshot object
    expect(a.snapshot()).toBe(b.snapshot());

    const other = mesh.live(mesh.db.select({ id: jobs.id }).from(jobs).limit(1));
    await other.ready;
    expect(other.snapshot()).not.toBe(a.snapshot());

    a.release();
    b.release();
    other.release();
  });

  test("releasing one consumer leaves the other running", async () => {
    const mesh = await open();
    const a = mesh.live(listing(mesh));
    const b = mesh.live(listing(mesh));
    await Promise.all([a.ready, b.ready]);

    a.release(); // refcount 2 -> 1: the shared query stays up
    const seen: number[] = [];
    b.subscribe((rows) => seen.push(rows.length));
    await mesh.db.insert(jobs).values({ id: "j1", title: "one" });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(seen.at(-1)).toBe(1);
    b.release();
  });
});

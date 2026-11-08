import type { MeshOptions } from "@syncmesh/client";
import type { PartitionKey } from "@syncmesh/kernel";

import { MeshStopped } from "@syncmesh/client";
import { parsePartitionKey } from "@syncmesh/kernel";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { scopedStores } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, createPartitionKeys, issueGrant, verifyGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { PostgresStorage, SqliteStorage } from "../index.js";

import { createClient, createServer, postgres, sqlite } from "../index.js";

/**
 * D47: `createClient` is the one constructor an app calls, so everything the mesh underneath can
 * be told has to be sayable here — or an app cannot say it at all.
 */
const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const org = partition("org", { roles: ladder("member") });
const schema = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), body: t.text() },
      partition: org,
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);
const ISSUER = createIdentity(seed(1)).unwrap();
const DEVICE = createIdentity(seed(60)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const HR = parsePartitionKey("org:hr").unwrap();
const ACME = parsePartitionKey("org:acme").unwrap();
const memory = () => sqlite({ driver: bunSqliteDriver(":memory:") });

type Transport = NonNullable<MeshOptions<never>["transports"]>[number];

/** A medium that only counts: what `start: false` must not open until it is asked to. */
const counting = () => {
  const counts = { started: 0 };
  const transport: Transport = {
    name: "counting",
    start: async () => void (counts.started += 1),
    whenReady: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  return { counts, transport };
};

describe("createClient takes no procedures (D47)", () => {
  test("a device with none opens a client of `$` surface alone", async () => {
    const client = createClient({ schema, identity: DEVICE, storage: memory() });
    await client.$ready;
    expect(client.$transports.list()).toEqual([]);
    expect(client.$mesh.engine.peerId).toBe(DEVICE.peerId);
    await client.$close();
  });

  test("a server with no procedures and no handlers still serves its contract", async () => {
    const server = await createServer({ schema, identity: DEVICE, storage: memory() });
    expect(server.openapi({ title: "relay", version: "1" })).toMatchObject({ paths: {} });
    await server.stop();
  });
});

describe("createClient({ start: false }) and $start() (B4, D47)", () => {
  test("nothing opens until $start(), and $start() before $ready is kept", async () => {
    const later = counting();
    const deferred = createClient({
      schema,
      identity: DEVICE,
      storage: memory(),
      transports: [later.transport],
      start: false,
    });
    await deferred.$ready;
    expect(deferred.$mesh.running()).toBe(false);
    expect(later.counts.started).toBe(0);
    expect(deferred.$start().isOk()).toBe(true);
    expect(deferred.$mesh.running()).toBe(true);
    expect(later.counts.started).toBe(1);
    expect(deferred.$start().isOk()).toBe(true); // idempotent
    expect(later.counts.started).toBe(1);
    await deferred.$close();

    // asked for while the database is still opening: honoured the moment the mesh exists
    const early = counting();
    const eager = createClient({
      schema,
      identity: DEVICE,
      storage: memory(),
      transports: [early.transport],
      start: false,
    });
    expect(eager.$start().isOk()).toBe(true);
    await eager.$ready;
    expect(eager.$mesh.running()).toBe(true);
    expect(early.counts.started).toBe(1);
    await eager.$close();
  });

  test("$start() after $close() is MeshStopped, as a value", async () => {
    const client = createClient({ schema, identity: DEVICE, storage: memory(), start: false });
    await client.$ready;
    await client.$close();
    const again = client.$start();
    expect(again.isErr() && MeshStopped.is(again.error)).toBe(true);
  });
});

describe("createClient reaches every mesh option (D47)", () => {
  test("clockDrift: a stamp an hour ahead is parked by default and folded under a wider bound", async () => {
    const ahead = createClient({
      schema,
      identity: createIdentity(seed(7)).unwrap(),
      storage: memory(),
      now: () => T0.add({ hours: 1 }),
    });
    await ahead.$ready;
    await ahead.$mesh.on("org:acme").unwrap().db.insert(notes).values({ id: "n1", body: "future" });
    const entries = (await ahead.$mesh.engine.eventsSince(new Map())).unwrap();

    const strict = createClient({ schema, identity: DEVICE, storage: memory(), now: () => T0 });
    const lenient = createClient({
      schema,
      identity: createIdentity(seed(90)).unwrap(),
      storage: memory(),
      now: () => T0,
      clockDrift: Temporal.Duration.from({ hours: 2 }),
    });
    await Promise.all([strict.$ready, lenient.$ready]);
    expect((await strict.$mesh.engine.receiveBatch(entries)).unwrap().quarantined).toBe(1);
    expect((await lenient.$mesh.engine.receiveBatch(entries)).unwrap().folded).toBe(1);
    await Promise.all([ahead.$close(), strict.$close(), lenient.$close()]);
  });

  test("trust.partitionKeys: a grant the issuer mints carries the sealed partition's key", async () => {
    const issuer = createClient({
      schema,
      identity: ISSUER,
      storage: memory(),
      now: () => T0,
      trust: {
        issuer: ISSUER.peerId,
        issuerKey: ISSUER,
        partitionKeys: createPartitionKeys({ sealed: (p: PartitionKey) => p === HR }),
      },
    });
    await issuer.$ready;
    const wire = issuer.$grants
      .issue({
        account: "a",
        device: DEVICE.peerId,
        partitions: [HR, ACME],
        validFor: Temporal.Duration.from({ days: 1 }),
      })
      .unwrap();
    const grant = verifyGrant(wire, ISSUER.peerId, T0).unwrap();
    expect(grant.keys?.map((key) => [key.partition, key.epoch])).toEqual([[HR, 1]]);
    await issuer.$close();
  });

  test("without trust.partitionKeys, rekey's panic names the option to pass", async () => {
    const issuer = createClient({
      schema,
      identity: ISSUER,
      storage: memory(),
      trust: { issuer: ISSUER.peerId, issuerKey: ISSUER },
    });
    await issuer.$ready;
    expect(() => issuer.$grants.rekey(HR)).toThrow(
      "createClient was not given `trust.partitionKeys`",
    );
    await issuer.$close();
  });

  test("storage.sweep: recovery sheds through the store set the client names", async () => {
    const set = scopedStores({
      tables: schema.entries.map((entry) => entry.table),
      driverFor: () => bunSqliteDriver(":memory:"),
    });
    const removed: string[] = [];
    const client = createClient({
      schema,
      identity: DEVICE,
      storage: sqlite({
        stores: (await set.storeFor(ACME)).unwrap(),
        sweep: { set, remove: (scope) => Promise.resolve(void removed.push(scope)) },
      }),
    });
    await client.$ready;
    // no grant held: the open store is a candidate, and the sweep is the client's to run
    expect(client.$recovery.stores?.candidates()).toEqual([{ scope: ACME, reason: "no-grant" }]);
    await client.$close();

    const plain = createClient({ schema, identity: DEVICE, storage: memory() });
    await plain.$ready;
    expect(plain.$recovery.stores).toBeUndefined();
    await plain.$close();
  });

  test("onNarrowed: the app hears its own grant narrow before anything is removed", async () => {
    const heard: (readonly string[])[] = [];
    let clock = T0;
    const client = createClient({
      schema,
      identity: DEVICE,
      storage: memory(),
      now: () => clock,
      trust: { issuer: ISSUER.peerId },
      onNarrowed: (narrowed) => void heard.push(narrowed.partitions.map(String)),
    });
    await client.$ready;
    const grantOver = (partitions: readonly PartitionKey[]) =>
      issueGrant(ISSUER, {
        account: "a",
        device: DEVICE.peerId,
        partitions,
        validFor: Temporal.Duration.from({ days: 1 }),
        now: clock,
      });
    client.$grants.register(grantOver([ACME, HR])).unwrap();
    clock = clock.add({ seconds: 1 });
    client.$grants.register(grantOver([ACME])).unwrap();
    await client.$flush();
    await client.$close(); // the close waits for the purge the narrowing queued
    expect(heard).toEqual([["org:hr"]]);
  });
});

describe("the options are grouped, and the groups are checked (D47)", () => {
  test("flat mesh names, wrong units and misplaced groups do not compile", () => {
    const driver = bunSqliteDriver(":memory:");
    const opts = { schema, identity: DEVICE } as const;
    // the type assertions below are the test; nothing here opens a mesh
    const never = (pg: PostgresStorage["driver"], sweep: SqliteStorage["sweep"]): void => {
      // @ts-expect-error the device's connection lives in `storage: sqlite({ driver })`
      createClient({ ...opts, driver });
      // @ts-expect-error the issuer is shipped config, under `trust`
      createClient({ ...opts, issuer: ISSUER.peerId });
      // @ts-expect-error `partitionKeys` is an issuer secret, under `trust` beside `issuerKey`
      createClient({ ...opts, partitionKeys: createPartitionKeys({ sealed: () => false }) });
      // @ts-expect-error a drift is a Temporal.Duration, never a bare number of milliseconds
      createClient({ ...opts, clockDrift: 300_000 });
      // @ts-expect-error `start` is a yes or a no
      createClient({ ...opts, start: "later" });
      // @ts-expect-error a sweep sheds SQLite store files; a postgres node has none to shed
      postgres({ driver: pg, sweep });
      // @ts-expect-error the hook for an ungranted peer is `admission`
      createClient({ ...opts, onGrantRequest: () => undefined });
    };
    void never;

    // and the right spellings do, with procedures absent
    const fine = (): void => {
      createClient({
        ...opts,
        start: false,
        clockDrift: Temporal.Duration.from({ minutes: 10 }),
        storage: sqlite({ driver, dir: ".data" }),
        trust: {
          issuer: ISSUER.peerId,
          issuerKey: ISSUER,
          partitionKeys: createPartitionKeys({ sealed: () => false }),
        },
        onNarrowed: () => undefined,
        admission: () => undefined,
      }).$start();
    };
    void fine;
  });
});

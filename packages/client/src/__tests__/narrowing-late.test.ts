import {
  createEngine,
  createMemoryEventStore,
  createMemoryStateStore,
  scopeFrom,
} from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey, readRow } from "@syncmesh/kernel";
import { column, key, row, seed, table } from "@syncmesh/kernel/test-fixtures";
import { memoryBlobStore } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { watchNarrowing } from "../narrowing.js";

const ISSUER = createIdentity(seed(1)).unwrap();
const DEVICE = createIdentity(seed(90)).unwrap();
const AUTHOR = createIdentity(seed(120)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();
const PAYROLL = parsePartitionKey("org:payroll").unwrap();
const NOTES = table("notes");
const TITLE = column("title");
// SAFETY: a test fixture; procedure naming rules arrive with the schema
const CREATE = "notes.create" as Parameters<ReturnType<typeof createEngine>["mutate"]>[0];

const engineFor = (
  peerId: typeof DEVICE.peerId,
  startMs: number,
  stateStore = createMemoryStateStore(),
) => {
  let ms = startMs;
  const clock = createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms++) });
  const store = createMemoryEventStore();
  return { engine: createEngine({ peerId, clock, store, stateStore }), store };
};

/**
 * A memory state store that holds the first two commits after a `remove`, each until released:
 * the purge's own commit, then the write queued behind it.
 */
const heldCommits = () => {
  const inner = createMemoryStateStore();
  const holds = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const entered = Promise.withResolvers<void>();
  let removed = false;
  let held = 0;
  const store = {
    ...inner,
    remove: async (keys: Parameters<typeof inner.remove>[0]) => {
      removed = true;
      return inner.remove(keys);
    },
    commit: async (...args: Parameters<typeof inner.commit>) => {
      const hold = removed ? holds[held] : undefined;
      if (hold !== undefined) {
        held += 1;
        if (held === 1) entered.resolve();
        await hold.promise;
      }
      return inner.commit(...args);
    },
  } satisfies typeof inner;
  return {
    store,
    entered: entered.promise,
    release: (index: 0 | 1) => holds[index]?.resolve(),
  };
};

const grantOf = (partitions: readonly (typeof ACME)[], at: number) =>
  issueGrant(ISSUER, {
    account: "acct_a",
    device: DEVICE.peerId,
    role: "member",
    partitions,
    validFor: Temporal.Duration.from({ days: 1 }),
    now: T0.add({ milliseconds: at }),
  });

describe("an event of a lost partition that arrives after the purge (D45)", () => {
  test("is purged on arrival, until the partition is granted again", async () => {
    const device = engineFor(DEVICE.peerId, 500);
    const author = engineFor(AUTHOR.peerId, 100);
    const grants = createGrantRegistry({ issuer: ISSUER.peerId, now: () => T0 });
    const told: unknown[] = [];
    const watch = watchNarrowing({
      engine: device.engine,
      self: DEVICE.peerId,
      grants,
      blobs: memoryBlobStore(),
      onNarrowed: (narrowed) => void told.push(narrowed),
    });
    const write = async (id: string) => {
      const event = (
        await author.engine.mutate(CREATE, (tx) => tx.insert(NOTES, key(id), row({ title: id })), {
          partition: PAYROLL,
        })
      ).unwrap();
      return (await author.store.all()).unwrap().filter((entry) => entry.event.id === event.id);
    };
    const holds = (id: string) => readRow(device.engine.state(), NOTES, key(id))?.get(TITLE) === id;

    grants.register(grantOf([ACME, PAYROLL], 0)).unwrap();
    (await device.engine.receiveBatch(await write("before"))).unwrap();
    expect(holds("before")).toBe(true);

    grants.register(grantOf([ACME], 1)).unwrap();
    await watch.idle();
    expect(holds("before")).toBe(false);
    expect(told.length).toBe(1);

    // in flight when the grant narrowed: it lands after the purge
    (await device.engine.receiveBatch(await write("late"))).unwrap();
    await watch.idle();
    expect(holds("late")).toBe(false);
    expect(told.length).toBe(1); // told once, not once per late event

    // a peer still on the wider grant hands over a snapshot carrying the lost partition's rows
    await write("snapshotted");
    await device.engine.installSnapshot(author.engine.snapshot());
    await watch.idle();
    expect(holds("snapshotted")).toBe(false);
    expect(holds("before")).toBe(false);
    expect(told.length).toBe(1);

    // granted again: an arrival is kept
    grants.register(grantOf([ACME, PAYROLL], 2)).unwrap();
    (await device.engine.receiveBatch(await write("after"))).unwrap();
    await watch.idle();
    expect(holds("after")).toBe(true);
    await watch.close();
  });

  test("a snapshot whose coverage lands after the rescope does not widen it back", async () => {
    const held = heldCommits();
    const device = engineFor(DEVICE.peerId, 500, held.store);
    const author = engineFor(AUTHOR.peerId, 100);
    const grants = createGrantRegistry({ issuer: ISSUER.peerId, now: () => T0 });
    const watch = watchNarrowing({
      engine: device.engine,
      self: DEVICE.peerId,
      grants,
      blobs: memoryBlobStore(),
    });
    const write = async (id: string, partition: typeof ACME) =>
      (
        await author.engine.mutate(CREATE, (tx) => tx.insert(NOTES, key(id), row({ title: id })), {
          partition,
        })
      ).unwrap();
    const partitions = () => scopeFrom(device.engine.coverage().scope).interest?.partitions;

    grants.register(grantOf([ACME, PAYROLL], 0)).unwrap();
    await write("kept", ACME);
    await write("bonus", PAYROLL);
    (await device.engine.receiveBatch((await author.store.all()).unwrap())).unwrap();

    grants.register(grantOf([ACME], 1)).unwrap();
    await held.entered;
    // an unscoped snapshot lands mid-purge: its rows merge now, its write and coverage wait
    const installing = device.engine.installSnapshot(author.engine.snapshot());
    held.release(0);
    await watch.idle();
    expect(partitions()).toEqual([ACME]);

    held.release(1);
    await installing;
    await watch.idle();
    expect(partitions()).toEqual([ACME]);
    expect(readRow(device.engine.state(), NOTES, key("bonus"))).toBeUndefined();
    await watch.close();
  });

  test("an empty unscoped snapshot adopted after the rescope does not widen it back", async () => {
    const device = engineFor(DEVICE.peerId, 500);
    const author = engineFor(AUTHOR.peerId, 100);
    const grants = createGrantRegistry({ issuer: ISSUER.peerId, now: () => T0 });
    const watch = watchNarrowing({
      engine: device.engine,
      self: DEVICE.peerId,
      grants,
      blobs: memoryBlobStore(),
    });
    const partitions = () => scopeFrom(device.engine.coverage().scope).interest?.partitions;

    grants.register(grantOf([ACME, PAYROLL], 0)).unwrap();
    (
      await author.engine.mutate(CREATE, (tx) => tx.insert(NOTES, key("x"), row({ title: "x" })), {
        partition: PAYROLL,
      })
    ).unwrap();
    (await device.engine.receiveBatch((await author.store.all()).unwrap())).unwrap();
    grants.register(grantOf([ACME], 1)).unwrap();
    await watch.idle();
    expect(partitions()).toEqual([ACME]);

    // a snapshot with no rows and no scope: nothing to fold, and still a claim on the coverage
    const { coverage } = author.engine.snapshot();
    (await device.engine.installSnapshot({ rows: [], coverage })).unwrap();
    await watch.idle();
    expect(partitions()).toEqual([ACME]);
    await watch.close();
  });
});

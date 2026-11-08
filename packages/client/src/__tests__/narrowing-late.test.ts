import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
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

const engineFor = (peerId: typeof DEVICE.peerId, startMs: number) => {
  let ms = startMs;
  const clock = createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms++) });
  const store = createMemoryEventStore();
  return { engine: createEngine({ peerId, clock, store }), store };
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

    // granted again: an arrival is kept
    grants.register(grantOf([ACME, PAYROLL], 2)).unwrap();
    (await device.engine.receiveBatch(await write("after"))).unwrap();
    await watch.idle();
    expect(holds("after")).toBe(true);
    watch.stop();
  });
});

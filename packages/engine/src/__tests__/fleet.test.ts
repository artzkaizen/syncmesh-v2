import type { PeerId, SyncEvent } from "@syncmesh/kernel";

import { parsePartitionKey, parseSchemaVersion } from "@syncmesh/kernel";
import { syncSchema, t, user } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { Engine, EngineOptions } from "../engine.js";

import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator } from "../validate.js";
import { CREATE, PEER_A, PEER_B, PEER_C, fakeClock, key, row, setup, table } from "./fixtures.js";

const USER = parsePartitionKey("user:acct_a").unwrap();
const NOTES = table("notes");
const MEMOS = table("memos");
const version = (n: number) => parseSchemaVersion(n).unwrap();
const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);
const WINDOW = Temporal.Duration.from({ seconds: 10 });

/** The lowest version per author, by the author's first letter. */
const readings = (engine: Engine, window?: Parameters<Engine["oldestSchema"]>[0]) =>
  Object.fromEntries(
    [...engine.oldestSchema(window)].map(([peer, reading]) => [
      peer.slice(0, 1),
      Number(reading.version),
    ]),
  );

/**
 * One author whose app updates between writes: each write is a build over the same log, so its
 * sequence runs on, and each stamps the version that build declares.
 */
const author = (peerId: PeerId, extra: Partial<EngineOptions> = {}) => {
  const store = createMemoryEventStore();
  return async (ms: number, schemaVersion?: number, into = NOTES): Promise<SyncEvent> => {
    const built = createEngine({
      peerId,
      clock: fakeClock(ms),
      store,
      ...extra,
      ...(schemaVersion !== undefined && { schemaVersion: version(schemaVersion) }),
    });
    const id = `r${ms}`;
    const written = await built.mutate(
      CREATE,
      (tx) => tx.insert(into, key(id), row({ id, body: "x" })),
      { partition: USER },
    );
    return written.unwrap();
  };
};

describe("oldestSchema: which builds are still writing (D31)", () => {
  test("per author, the lowest stamp seen; an event without one reads as 1", async () => {
    const device = setup(PEER_A, 100, { schemaVersion: version(4) }).engine;
    const b = author(PEER_B);
    const c = author(PEER_C);
    const older = await b(1_000, 2);
    const newer = await b(2_000, 3);
    (await device.receiveBatch([{ event: newer }, { event: await c(1_500) }])).unwrap();
    expect(readings(device)).toEqual({ b: 3, c: 1 });
    // the same author on an older build is the reading that matters, not its newest
    (await device.receive({ event: older })).unwrap();
    expect(readings(device)).toEqual({ b: 2, c: 1 });
    // its own writes count too: this device is an author on its own build
    const own = await device.mutate(
      CREATE,
      (tx) => tx.insert(NOTES, key("own"), row({ id: "own", body: "x" })),
      { partition: USER },
    );
    expect(own.isOk()).toBe(true);
    expect(readings(device)).toEqual({ a: 4, b: 2, c: 1 });
  });

  test("a window drops what was last seen before it, judged by the event's own stamp", async () => {
    const device = setup(PEER_A).engine;
    const b = author(PEER_B);
    (
      await device.receiveBatch([{ event: await b(1_000, 2) }, { event: await b(30_000, 3) }])
    ).unwrap();
    expect(readings(device)).toEqual({ b: 2 });
    expect(readings(device, { now: at(35_000), within: WINDOW })).toEqual({ b: 3 });
    expect(readings(device, { now: at(60_000), within: WINDOW })).toEqual({});
  });

  test("a reading stamped after the window's now waits for now to reach it", async () => {
    const device = setup(PEER_A).engine;
    const b = author(PEER_B);
    (await device.receive({ event: await b(100_000, 2) })).unwrap();
    // a clock running ahead must not look freshly seen in every window it is ever asked about
    expect(readings(device, { now: at(35_000), within: WINDOW })).toEqual({});
    expect(readings(device, { now: at(105_000), within: WINDOW })).toEqual({ b: 2 });
    expect(readings(device, { now: at(120_000), within: WINDOW })).toEqual({});
  });

  test("a cursors frame's version counts; an ack that announced none says nothing", () => {
    const device = setup(PEER_A).engine;
    device.acknowledge(PEER_B, new Map(), at(5_000), version(6));
    device.acknowledge(PEER_C, new Map(), at(5_000));
    expect(readings(device)).toEqual({ b: 6 });
    expect([...device.oldestSchema().values()]).toEqual([{ version: version(6), at: at(5_000) }]);
  });

  test("a parked write is still a build writing: a dropped table's old writer is in it", async () => {
    const v1 = syncSchema({
      tables: {
        memos: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: user },
      },
    });
    const v3 = syncSchema({
      schemaVersion: 3,
      dropped: ["memos"],
      tables: {
        notes: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: user },
      },
    });
    const b = author(PEER_B, { validate: createValidator({ schema: v1, grantFor: null }) });
    const memo = await b(1_000, undefined, MEMOS);
    const validate = createValidator({ schema: v3, grantFor: null });
    const device = setup(PEER_A, 100, { validate }).engine;
    (await device.receive({ event: memo })).unwrap();
    expect(device.quarantine().map((p) => p.reason)).toEqual(["dropped-table"]);
    expect(readings(device)).toEqual({ b: 1 });
  });
});

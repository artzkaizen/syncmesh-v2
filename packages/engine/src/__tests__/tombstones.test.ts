import { getRecord, hlcOf, isVisible, readRow } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { Engine } from "../engine.js";

import { openEngine } from "../boot.js";
import { tableDigests } from "../digest.js";
import { createLink } from "../link.js";
import { createMemoryStateStore } from "../state-store.js";
import { tombstoneFrontier } from "../tombstones.js";
import {
  CREATE,
  NOTES,
  PEER_A,
  PEER_B,
  PEER_C,
  column,
  fakeClock,
  key,
  row,
  setup,
} from "./fixtures.js";

/** Well after every fixture stamp (they sit at ~100 ms): old enough to compact. */
const T0 = Temporal.Instant.fromEpochMilliseconds(10 * 60 * 60 * 1000);

const insert = (engine: Engine, k: string, body: string) =>
  engine.mutate(CREATE, (tx) => tx.insert(NOTES, key(k), row({ body })));
const remove = (engine: Engine, k: string) =>
  engine.mutate(CREATE, (tx) => tx.delete(NOTES, key(k)));
const record = (engine: Engine, k: string) => getRecord(engine.state(), NOTES, key(k));
const body = (engine: Engine, k: string) =>
  readRow(engine.state(), NOTES, key(k))?.get(column("body"));
const digest = (engine: Engine) => tableDigests(engine.state()).get(NOTES);

/** An authority and two devices, each linked to the authority, every state persisted. */
const fleet = () => {
  const stateA = createMemoryStateStore();
  const a = setup(PEER_A, 100, { stateStore: stateA });
  const b = setup(PEER_B, 100, { stateStore: createMemoryStateStore() });
  const late = setup(PEER_C, 100, { stateStore: createMemoryStateStore() });
  const ab = createLink(a.engine, b.engine, { now: () => T0 });
  const al = createLink(a.engine, late.engine, { now: () => T0 });
  return { a, b, late, ab, al, stateA };
};

describe("tombstone collection — gaps O1", () => {
  test("a delete every peer has acked is collected from the state and the state store", async () => {
    const { a, b, late, ab, al, stateA } = fleet();
    (await insert(a.engine, "n1", "kept")).unwrap();
    (await insert(a.engine, "n2", "gone")).unwrap();
    (await remove(a.engine, "n2")).unwrap();
    for (const link of [ab, al]) (await link.catchUp()).unwrap();
    expect(isVisible(record(b.engine, "n2") ?? { cells: new Map() })).toBe(false);

    const done = (await a.engine.compact({ now: T0 })).unwrap();
    expect(done.tombstones).toBe(1);
    expect(record(a.engine, "n2")).toBeUndefined();
    expect(body(a.engine, "n1")).toBe("kept");
    // the state store forgot it too: a reboot from it has no such row
    const rebooted = (
      await openEngine({ peerId: PEER_A, clock: fakeClock(1), store: a.store, stateStore: stateA })
    ).unwrap();
    expect(record(rebooted, "n2")).toBeUndefined();
    expect(body(rebooted, "n1")).toBe("kept");
    // a peer that still holds the tombstone shows the same rows, and digests say so
    expect(record(b.engine, "n2")).toBeDefined();
    expect(digest(b.engine)).toBe(digest(a.engine));
    expect(digest(late.engine)).toBe(digest(a.engine));
  });

  test("a late peer pins the delete it has not acked, then converges and lets it go", async () => {
    const { a, b, late, ab, al } = fleet();
    (await insert(a.engine, "n1", "row")).unwrap();
    for (const link of [ab, al]) (await link.catchUp()).unwrap();
    expect(body(late.engine, "n1")).toBe("row");

    // the late peer goes away holding the row; the delete reaches everyone else
    al.setOnline(false);
    (await remove(a.engine, "n1")).unwrap();
    (await ab.catchUp()).unwrap();
    const pinned = (await a.engine.compact({ now: T0 })).unwrap();
    expect(pinned.tombstones).toBe(0);
    expect(record(a.engine, "n1")).toBeDefined();

    // it comes back, catches up from the log the delete is still in, and agrees
    al.setOnline(true);
    (await al.catchUp()).unwrap();
    expect(body(late.engine, "n1")).toBeUndefined();
    for (const peer of [b, late]) expect(digest(peer.engine)).toBe(digest(a.engine));

    // once it has acked the delete too, the authority collects it, and still agrees
    (await al.catchUp()).unwrap();
    const collected = (await a.engine.compact({ now: T0 })).unwrap();
    expect(collected.tombstones).toBe(1);
    expect(record(a.engine, "n1")).toBeUndefined();
    for (const peer of [b, late]) expect(digest(peer.engine)).toBe(digest(a.engine));
  });

  test("a row written again after its delete is no tombstone, and stays", async () => {
    const { a, ab, al } = fleet();
    (await insert(a.engine, "n1", "first")).unwrap();
    (await remove(a.engine, "n1")).unwrap();
    (await insert(a.engine, "n1", "again")).unwrap();
    for (const link of [ab, al]) (await link.catchUp()).unwrap();
    const done = (await a.engine.compact({ now: T0 })).unwrap();
    expect(done.tombstones).toBe(0);
    expect(body(a.engine, "n1")).toBe("again");
  });

  test("keepTombstones keeps them", async () => {
    const { a, ab, al } = fleet();
    (await insert(a.engine, "n1", "row")).unwrap();
    (await remove(a.engine, "n1")).unwrap();
    for (const link of [ab, al]) (await link.catchUp()).unwrap();
    const done = (await a.engine.compact({ now: T0, keepTombstones: true })).unwrap();
    expect(done.tombstones).toBe(0);
    expect(record(a.engine, "n1")).toBeDefined();
  });

  test("tombstones a reboot loads are found and collected too", async () => {
    const { a, ab, al, stateA } = fleet();
    (await insert(a.engine, "n1", "row")).unwrap();
    (await remove(a.engine, "n1")).unwrap();
    for (const link of [ab, al]) (await link.catchUp()).unwrap();
    const rebooted = (
      await openEngine({ peerId: PEER_A, clock: fakeClock(1), store: a.store, stateStore: stateA })
    ).unwrap();
    // acks live in memory: the rebooted engine hears them again before its floor can move
    const held = (await a.engine.cursors()).unwrap();
    rebooted.acknowledge(PEER_B, held, T0);
    rebooted.acknowledge(PEER_C, held, T0);
    const done = (await rebooted.compact({ now: T0 })).unwrap();
    expect(done.tombstones).toBe(1);
    expect(record(rebooted, "n1")).toBeUndefined();
  });
});

describe("tombstoneFrontier", () => {
  test("is the oldest floor stamp over every author, and absent while any has none", () => {
    const stamps = new Map([
      [PEER_A, hlcOf(500, 0)],
      [PEER_B, hlcOf(300, 2)],
    ]);
    expect(tombstoneFrontier([PEER_A, PEER_B], stamps)).toEqual(hlcOf(300, 2));
    expect(tombstoneFrontier([PEER_A, PEER_B, PEER_C], stamps)).toBeUndefined();
    expect(tombstoneFrontier([], stamps)).toBeUndefined();
  });
});

import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { compareHlc, parsePeerId, readRow } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { Engine } from "../engine.js";
import type { EventStore } from "../store.js";

import { openEngine } from "../boot.js";
import { dueForCompaction } from "../compaction.js";
import { createLink } from "../link.js";
import { StateCorrupt, createMemoryStateStore, type StateStore } from "../state-store.js";
import {
  CREATE,
  NOTES,
  PEER_A,
  PEER_B,
  column,
  fakeClock,
  key,
  row,
  seq,
  setup,
} from "./fixtures.js";

const PEER_C = parsePeerId("c".repeat(64)).unwrap();
const HOUR = Temporal.Duration.from({ hours: 1 });
const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);
/** Well after every fixture stamp (they sit at ~100 ms). */
const T0 = at(10 * 60 * 60 * 1000);

const write = (engine: Engine, k: string, body: string, local?: true) =>
  engine.mutate(
    CREATE,
    (tx) => tx.insert(NOTES, key(k), row({ body })),
    local === undefined ? {} : { local },
  );
const count = async (store: EventStore) => (await store.all()).unwrap().length;
const bodies = (engine: Engine) =>
  [...(engine.state().get(NOTES)?.keys() ?? [])].map((k) =>
    readRow(engine.state(), NOTES, k)?.get(column("body")),
  );
const cursors = (entries: readonly (readonly [PeerId, SeqNum])[]) => new Map(entries);

const pair = () => {
  const stateA = createMemoryStateStore();
  const a = setup(PEER_A, 100, { stateStore: stateA });
  const b = setup(PEER_B, 100, { stateStore: createMemoryStateStore() });
  const link = createLink(a.engine, b.engine, { now: () => T0 });
  return { a, b, link, stateA };
};

describe("compaction — RFC-0015 §2", () => {
  test("refused when nothing persists state", async () => {
    const { engine } = setup(PEER_A);
    const r = await engine.compact({ now: T0 });
    expect(r.isErr() && r.error._tag).toBe("CompactionRefused");
  });

  test("unobservable: state, cursors and later sync are identical after compact()", async () => {
    const { a, b, link, stateA } = pair();
    for (const k of ["n1", "n2", "n3", "n4", "n5"]) (await write(a.engine, k, k)).unwrap();
    (await link.catchUp()).unwrap();
    expect(await count(b.store)).toBe(5);

    const done = (await a.engine.compact({ now: T0 })).unwrap();
    expect(done.removed).toBe(5);
    expect(done.floor.synced.get(PEER_A)).toBe(seq(5));
    expect(await count(a.store)).toBe(0);
    expect(new Set(bodies(a.engine))).toEqual(new Set(["n1", "n2", "n3", "n4", "n5"]));
    expect((await a.engine.cursors()).unwrap().get(PEER_A)).toBe(seq(5));

    const next = (await write(a.engine, "n6", "n6")).unwrap();
    expect(next.seqNum).toBe(seq(6));
    (await write(b.engine, "b1", "b1")).unwrap();
    await link.flush();
    (await link.catchUp()).unwrap();
    expect(await count(b.store)).toBe(7);
    expect(await count(a.store)).toBe(2);
    expect(bodies(b.engine)).toHaveLength(7);

    const rebooted = (
      await openEngine({ peerId: PEER_A, clock: fakeClock(1), store: a.store, stateStore: stateA })
    ).unwrap();
    expect(bodies(rebooted)).toHaveLength(7);
    const afterReboot = (await write(rebooted, "n7", "n7")).unwrap();
    expect(afterReboot.seqNum).toBe(seq(7));
    expect(compareHlc(afterReboot.hlc, next.hlc)).toBe(1);
  });

  test("keepAtLeast keeps young events whatever the floor says", async () => {
    const { a, link } = pair();
    for (const k of ["n1", "n2"]) (await write(a.engine, k, k)).unwrap();
    (await link.catchUp()).unwrap();
    const now = at(100 + 60 * 60 * 1000);
    expect(
      (await a.engine.compact({ now, keepAtLeast: Temporal.Duration.from({ hours: 2 }) })).unwrap()
        .removed,
    ).toBe(0);
    expect(
      (
        await a.engine.compact({ now, keepAtLeast: Temporal.Duration.from({ minutes: 30 }) })
      ).unwrap().removed,
    ).toBe(2);
  });

  test("a silent peer pins the floor until forgetPeersAfter passes", async () => {
    const { engine, store } = setup(PEER_A, 100, { stateStore: createMemoryStateStore() });
    for (const k of ["n1", "n2", "n3", "n4", "n5"]) (await write(engine, k, k)).unwrap();
    engine.acknowledge(PEER_B, cursors([[PEER_A, seq(5)]]), T0);
    engine.acknowledge(PEER_C, cursors([[PEER_A, seq(2)]]), at(0));

    expect(
      (
        await engine.compact({ now: T0, forgetPeersAfter: Temporal.Duration.from({ days: 1 }) })
      ).unwrap().removed,
    ).toBe(2);
    expect(await count(store)).toBe(3);
    expect((await engine.compact({ now: T0, forgetPeersAfter: HOUR })).unwrap().removed).toBe(3);
    expect(await count(store)).toBe(0);
  });

  test("no counted peer, nothing synced goes; local events go regardless", async () => {
    const { engine, store } = setup(PEER_A, 100, { stateStore: createMemoryStateStore() });
    (await write(engine, "n1", "n1")).unwrap();
    (await write(engine, "d1", "d1", true)).unwrap();
    (await write(engine, "d2", "d2", true)).unwrap();
    const done = (await engine.compact({ now: T0 })).unwrap();
    expect(done.removed).toBe(2);
    expect(done.floor.local.get(PEER_A)).toBe(seq(2));
    expect((await store.all()).unwrap().map(({ event: e }) => e.local ?? false)).toEqual([false]);
  });

  test("the floor never passes what the state store has persisted", async () => {
    const inner = createMemoryStateStore();
    let accept = 3;
    const stateStore: StateStore = {
      ...inner,
      commit: (rows, coverage) =>
        accept-- > 0 ? inner.commit(rows, coverage) : Promise.resolve(Result.ok(undefined)),
    };
    const { engine, store } = setup(PEER_A, 100, { stateStore });
    for (const k of ["n1", "n2", "n3", "n4", "n5"]) (await write(engine, k, k)).unwrap();
    engine.acknowledge(PEER_B, cursors([[PEER_A, seq(5)]]), T0);
    const done = (await engine.compact({ now: T0 })).unwrap();
    expect(done.removed).toBe(3);
    expect(done.floor.synced.get(PEER_A)).toBe(seq(3));
    expect(await count(store)).toBe(2);
  });

  test("a corrupt cache over a compacted log fails boot instead of opening a partial state", async () => {
    const inner = createMemoryStateStore();
    let corrupt = false;
    const stateStore: StateStore = {
      ...inner,
      loadAll: () =>
        corrupt
          ? Promise.resolve(Result.err(new StateCorrupt({ message: "row n1 does not decode" })))
          : inner.loadAll(),
    };
    const { engine, store } = setup(PEER_A, 100, { stateStore });
    (await write(engine, "n1", "n1")).unwrap();
    engine.acknowledge(PEER_B, cursors([[PEER_A, seq(1)]]), T0);
    expect((await engine.compact({ now: T0 })).unwrap().removed).toBe(1);

    corrupt = true;
    const booted = await openEngine({ peerId: PEER_A, clock: fakeClock(1), store, stateStore });
    expect(booted.isErr() && booted.error._tag).toBe("StateCorrupt");
    expect(booted.isErr() && booted.error.message).toContain("rejoin from a peer");
  });
});

describe("the size trigger — D05, automerge's rule", () => {
  test("bytes decide, not a count of events", () => {
    expect(dueForCompaction({ incrementalBytes: 4096, snapshotBytes: 4096 })).toBe(true);
    expect(dueForCompaction({ incrementalBytes: 4097, snapshotBytes: 4096 })).toBe(true);
    expect(dueForCompaction({ incrementalBytes: 4095, snapshotBytes: 4096 })).toBe(false);
    // a state this small is cheaper to rewrite than to reason about
    expect(dueForCompaction({ incrementalBytes: 0, snapshotBytes: 1023 })).toBe(true);
    expect(dueForCompaction({ incrementalBytes: 0, snapshotBytes: 1024 })).toBe(false);
  });

  test("a log that has not earned it is left alone; the same log over threshold is compacted", async () => {
    const { engine, store } = setup(PEER_A, 100, { stateStore: createMemoryStateStore() });
    for (const k of ["n1", "n2"]) (await write(engine, k, k)).unwrap();
    engine.acknowledge(PEER_B, cursors([[PEER_A, seq(2)]]), T0);

    const idle = (
      await engine.compact({ now: T0, sizes: { incrementalBytes: 100, snapshotBytes: 8192 } })
    ).unwrap();
    expect(idle.removed).toBe(0);
    expect(idle.floor.synced.size).toBe(0);
    expect(await count(store)).toBe(2);

    const due = (
      await engine.compact({ now: T0, sizes: { incrementalBytes: 8192, snapshotBytes: 8192 } })
    ).unwrap();
    expect(due.removed).toBe(2);
    expect(await count(store)).toBe(0);
  });

  test("no state store still refuses, whatever the sizes say", async () => {
    const { engine } = setup(PEER_A);
    const r = await engine.compact({ now: T0, sizes: { incrementalBytes: 0, snapshotBytes: 0 } });
    expect(r.isErr() && r.error._tag).toBe("CompactionRefused");
  });
});

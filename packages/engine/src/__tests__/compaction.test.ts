import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { compareHlc, parsePeerId, readRow } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { Engine } from "../engine.js";
import type { EventStore } from "../store.js";

import { openEngine } from "../boot.js";
import { dueForCompaction } from "../compaction.js";
import { refoldable } from "../compaction.js";
import { unheldBelow } from "../coverage.js";
import { createLink } from "../link.js";
import { StateCorrupt, createMemoryStateStore, type StateStore } from "../state-store.js";
import { createMemoryEventStore } from "../store.js";
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
  const stateB = createMemoryStateStore();
  const b = setup(PEER_B, 100, { stateStore: stateB });
  const link = createLink(a.engine, b.engine, { now: () => T0 });
  return { a, b, link, stateA, stateB };
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

  test("the floor a peer is sent is what the store recorded, kept across a reboot (D46)", async () => {
    const { a, link, stateA } = pair();
    for (const k of ["n1", "n2", "n3"]) (await write(a.engine, k, k)).unwrap();
    (await link.catchUp()).unwrap();
    expect(a.engine.floor().size).toBe(0);

    // asked to compact everything, a run keeps the young: the floor says what was removed
    const now = at(100 + 60 * 60 * 1000);
    const young = Temporal.Duration.from({ hours: 2 });
    (await a.engine.compact({ now, keepAtLeast: young })).unwrap();
    expect(a.engine.floor().size).toBe(0);
    (await a.engine.compact({ now })).unwrap();
    expect(a.engine.floor()).toEqual(cursors([[PEER_A, seq(3)]]));

    const rebooted = (
      await openEngine({ peerId: PEER_A, clock: fakeClock(1), store: a.store, stateStore: stateA })
    ).unwrap();
    expect(rebooted.floor()).toEqual(cursors([[PEER_A, seq(3)]]));
    // local events never travel, so their half of the floor is not the engine's to send
    (await write(rebooted, "d1", "d1", true)).unwrap();
    (await rebooted.compact({ now: T0 })).unwrap();
    expect(rebooted.floor()).toEqual(cursors([[PEER_A, seq(3)]]));
  });

  test("coverage a snapshot adopted with no log behind it is a floor too, kept across a reboot (D46)", async () => {
    const { a, b, link, stateB } = pair();
    (await write(a.engine, "n1", "n1")).unwrap();
    (await link.catchUp()).unwrap();
    link.close();
    for (const k of ["n2", "n3"]) (await write(a.engine, k, k)).unwrap();
    // b holds A's first event and joins from state for the rest: its log lacks 2 and 3
    (await b.engine.installSnapshot(a.engine.snapshot())).unwrap();
    expect(b.engine.coverage().synced.get(PEER_A)).toBe(seq(3));
    expect(b.engine.floor()).toEqual(cursors([[PEER_A, seq(3)]]));
    // persisted with the coverage it qualifies, at once: a restart before the next fold keeps it
    const right = (
      await openEngine({ peerId: PEER_B, clock: fakeClock(1), store: b.store, stateStore: stateB })
    ).unwrap();
    expect(right.coverage().synced.get(PEER_A)).toBe(seq(3));
    expect(right.floor()).toEqual(cursors([[PEER_A, seq(3)]]));

    // events after the install are held, so the floor does not move with them
    (await write(a.engine, "n4", "n4")).unwrap();
    (await createLink(a.engine, b.engine, { now: () => T0 }).catchUp()).unwrap();
    expect(b.engine.coverage().synced.get(PEER_A)).toBe(seq(4));
    expect((await b.store.all()).unwrap().map(({ event }) => event.seqNum)).toEqual([
      seq(1),
      seq(4),
    ]);
    expect(b.engine.floor()).toEqual(cursors([[PEER_A, seq(3)]]));

    const rebooted = (
      await openEngine({ peerId: PEER_B, clock: fakeClock(1), store: b.store, stateStore: stateB })
    ).unwrap();
    expect(rebooted.floor()).toEqual(cursors([[PEER_A, seq(3)]]));
  });

  test("coverage a pass-over adopted is no floor, in the session or after a reboot (D46)", async () => {
    const { a, b, link, stateB } = pair();
    (await write(a.engine, "n1", "n1")).unwrap();
    (await link.catchUp()).unwrap();
    link.close();
    for (const k of ["n2", "n3"]) (await write(a.engine, k, k)).unwrap();
    // A:2 was withheld from b and passed over (D24, D40): the relay or the authority has it
    b.engine.adoptCoverage({ synced: cursors([[PEER_A, seq(2)]]), local: new Map() });
    const rest = (await a.engine.eventsSince(cursors([[PEER_A, seq(2)]]))).unwrap();
    (await b.engine.receiveBatch(rest)).unwrap();
    expect(b.engine.coverage().synced.get(PEER_A)).toBe(seq(3));
    expect(b.engine.floor().size).toBe(0);

    const rebooted = (
      await openEngine({ peerId: PEER_B, clock: fakeClock(1), store: b.store, stateStore: stateB })
    ).unwrap();
    expect(rebooted.coverage().synced.get(PEER_A)).toBe(seq(3));
    expect(rebooted.floor().size).toBe(0);
  });

  test("unheldBelow: the highest sequence in the range the log lacks, or nothing", () => {
    const to = cursors([
      [PEER_A, seq(5)],
      [PEER_C, seq(2)],
    ]);
    const held = new Map([
      [PEER_A, [seq(4), seq(5)]],
      [PEER_C, [seq(2)]],
    ]);
    expect(
      unheldBelow(
        cursors([
          [PEER_A, seq(1)],
          [PEER_C, seq(1)],
        ]),
        to,
        held,
      ),
    ).toEqual(cursors([[PEER_A, seq(3)]]));
    expect(unheldBelow(cursors([[PEER_A, seq(3)]]), to, held)).toEqual(cursors([[PEER_C, seq(1)]]));
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

  /**
   * The pair `refoldable` answers, and the reason the answer is not always yes.
   *
   * RFC-0022 wants to throw the folded state away whenever the schema changes and rebuild it from
   * the log. That works until the log has been compacted: compaction deletes events once the
   * state that stood for them was persisted, and only ever that far, so below a floor the folded
   * state is not a cache of the log — it is the **only copy**.
   */
  test("state is refoldable until the log is compacted, and then it is not", async () => {
    const stateStore = createMemoryStateStore();
    const { engine, store } = setup(PEER_A, 100, { stateStore });
    (await write(engine, "n1", "n1")).unwrap();
    expect((await refoldable(store)).unwrap()).toBe(true);

    engine.acknowledge(PEER_B, cursors([[PEER_A, seq(1)]]), T0);
    expect((await engine.compact({ now: T0 })).unwrap().removed).toBe(1);
    // the events that stood for these rows are gone; the rows are now the durable copy
    expect((await refoldable(store)).unwrap()).toBe(false);
  });

  /**
   * The same refusal, for a cache that is **gone** rather than damaged.
   *
   * Boot asked about the floors on the corrupt path and not on the empty one, because for most of
   * this system's life they were the same case: no folded state meant a database nobody had
   * written, and a fresh log has no floor. They stop being the same case the moment the state
   * store can be discarded on purpose — a schema change that opens a new state file (RFC-0022),
   * an operator clearing a cache — and the difference is a device that rebuilds whatever sits
   * above the floor, drops the rest, and reports itself healthy.
   */
  test("an absent cache over a compacted log fails boot too, not just a corrupt one", async () => {
    const stateStore = createMemoryStateStore();
    const { engine, store } = setup(PEER_A, 100, { stateStore });
    (await write(engine, "n1", "n1")).unwrap();
    engine.acknowledge(PEER_B, cursors([[PEER_A, seq(1)]]), T0);
    expect((await engine.compact({ now: T0 })).unwrap().removed).toBe(1);

    // the cache is thrown away, which is exactly what a hash-named state file does on a change
    (await stateStore.clear()).unwrap();
    const booted = await openEngine({ peerId: PEER_A, clock: fakeClock(1), store, stateStore });
    expect(booted.isErr() && booted.error._tag).toBe("StateCorrupt");
    expect(booted.isErr() && booted.error.message).toContain("rejoin from a peer");
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

describe("below the floor (gaps U1, U33)", () => {
  /** Three of A's events at b: the first and third held, the second withheld and passed over. */
  const withheld = async () => {
    const { a, b, link, stateB } = pair();
    (await write(a.engine, "n1", "n1")).unwrap();
    (await link.catchUp()).unwrap();
    link.close();
    for (const k of ["n2", "n3"]) (await write(a.engine, k, k)).unwrap();
    // A:2 was withheld from b and passed over (D24, D40); A:3 reached it
    b.engine.adoptCoverage({ synced: cursors([[PEER_A, seq(2)]]), local: new Map() });
    const [first, second, third] = (await a.store.all()).unwrap();
    if (first === undefined || second === undefined || third === undefined)
      throw new Error("a holds three events");
    (await b.engine.receiveBatch([third])).unwrap();
    b.engine.acknowledge(PEER_A, a.engine.coverage().synced, T0);
    return { a, b, stateB, first, second, third };
  };

  test("an event compaction removed is skipped, not taken again below the floor (U1)", async () => {
    const { b, first, second, third } = await withheld();
    expect((await b.engine.compact({ now: T0 })).unwrap().removed).toBe(2);
    expect(await count(b.store)).toBe(0);

    // a relay hop, or a peer whose cursors went back, offers all three again
    const report = (await b.engine.receiveBatch([first, second, third])).unwrap();
    // the two compaction took stay out of the log; the withheld one is history b never folded
    expect(report.folded).toBe(1);
    expect((await b.store.all()).unwrap().map(({ event }) => event.seqNum)).toEqual([seq(2)]);
    expect(new Set(bodies(b.engine))).toEqual(new Set(["n1", "n2", "n3"]));
  });

  test("an event evicted below the floor is taken again when it comes back (U1)", async () => {
    const { b, first, third } = await withheld();
    (await b.engine.compact({ now: T0 })).unwrap();
    // A:3 is put back and then evicted by a purge (D45): a later widening brings it again
    (await b.store.append(third)).unwrap();
    (await b.store.evict([third.event.id])).unwrap();
    expect((await b.store.compacted(third.event)).unwrap()).toBe(false);
    expect((await b.store.compacted(first.event)).unwrap()).toBe(true);
    expect((await b.engine.receiveBatch([first, third])).unwrap().folded).toBe(1);
  });

  test("a state that is not read at all does not rebuild without the rows a snapshot installed (U33)", async () => {
    const { a, b } = pair();
    for (const k of ["n1", "n2", "n3"]) (await write(a.engine, k, k)).unwrap();
    (await b.engine.installSnapshot(a.engine.snapshot())).unwrap();
    expect((await b.store.installedBelow()).unwrap()).toEqual(cursors([[PEER_A, seq(3)]]));
    expect((await refoldable(b.store)).unwrap()).toBe(false);
    // a schema change that opens a new state file, or an operator deleting it
    const fresh = await openEngine({
      peerId: PEER_B,
      clock: fakeClock(1),
      store: b.store,
      stateStore: createMemoryStateStore(),
    });
    expect(fresh.isErr() && fresh.error).toBeInstanceOf(StateCorrupt);
    expect(fresh.isErr() && fresh.error.message).toContain("installed from a snapshot");
  });

  test("a state whose rows and cursors both cannot be read is refused, not rebuilt from the log (U33)", async () => {
    const { a, b, stateB } = pair();
    for (const k of ["n1", "n2"]) (await write(a.engine, k, k)).unwrap();
    (await b.engine.installSnapshot(a.engine.snapshot())).unwrap();
    const unreadable = () =>
      Promise.resolve(Result.err(new StateCorrupt({ message: "the cache does not decode" })));
    const broken: StateStore = { ...stateB, loadAll: unreadable, loadCursors: unreadable };
    const booted = await openEngine({
      peerId: PEER_B,
      clock: fakeClock(1),
      store: b.store,
      stateStore: broken,
    });
    expect(booted.isErr() && booted.error.message).toContain("installed from a snapshot");
    // nothing was cleared: the rows are still where a rejoin can find them
    expect((await stateB.loadAll()).unwrap().get(NOTES)?.size).toBe(2);
  });

  test("a crash between an install's rows and its cursors still reopens (U33)", async () => {
    const a = setup(PEER_A, 100, { stateStore: createMemoryStateStore() });
    for (const k of ["n1", "n2"]) (await write(a.engine, k, k)).unwrap();
    const real = createMemoryStateStore();
    let commits = 0;
    const { promise: died, resolve: die } = Promise.withResolvers<void>();
    // the process dies once the rows land: the next commit never returns, and nothing after it runs
    const dying: StateStore = {
      ...real,
      commit: (rows, coverage) => {
        commits += 1;
        if (commits === 1) return real.commit(rows, coverage);
        die();
        return new Promise(() => undefined);
      },
    };
    const b = setup(PEER_B, 100, { stateStore: dying });
    const installing = b.engine.installSnapshot(a.engine.snapshot());
    await died;
    expect((await real.isEmpty()).unwrap()).toBe(true);
    // no cursors claim the install, so the log is folded again and the snapshot asked for again
    const reopened = await openEngine({
      peerId: PEER_B,
      clock: fakeClock(1),
      store: b.store,
      stateStore: real,
    });
    expect(reopened.isOk()).toBe(true);
    expect(installing).toBeInstanceOf(Promise);
  });

  test("a state installed before the log kept the floor gives it to the log at boot (U33)", async () => {
    const { a, b, stateB } = pair();
    (await write(a.engine, "n1", "n1")).unwrap();
    (await b.engine.installSnapshot(a.engine.snapshot())).unwrap();
    // the same log as a build that kept the floor only with the state's cursors left it
    const store = createMemoryEventStore();
    (await store.appendBatch((await b.store.all()).unwrap())).unwrap();
    (await openEngine({ peerId: PEER_B, clock: fakeClock(1), store, stateStore: stateB })).unwrap();
    expect((await store.installedBelow()).unwrap()).toEqual(cursors([[PEER_A, seq(1)]]));
  });
});

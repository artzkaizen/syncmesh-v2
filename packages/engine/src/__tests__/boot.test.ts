import { compareHlc, readRow, type RowKey } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { describe, expect, test } from "bun:test";

import type { Engine } from "../engine.js";
import type { EngineError } from "../errors.js";

import { openEngine } from "../boot.js";
import { StateCorrupt, createMemoryStateStore, type StateStore } from "../state-store.js";
import { StoreFailure } from "../store.js";
import { CREATE, N1, NOTES, PEER_A, column, fakeClock, key, row, seq, setup } from "./fixtures.js";

const body = (engine: Engine, k: RowKey) => readRow(engine.state(), NOTES, k)?.get(column("body"));
const N2 = key("n2");

describe("openEngine — boot from the log", () => {
  test("folds the log and moves the clock past the highest stored stamp before numbering", async () => {
    const { store, engine } = setup(PEER_A, 500);
    const stored = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body: "a" })))
    ).unwrap();

    const clock = fakeClock(100);
    const booted = (await openEngine({ peerId: PEER_A, clock, store })).unwrap();
    expect(body(booted, N1)).toBe("a");

    const next = (
      await booted.mutate(CREATE, (tx) => tx.insert(NOTES, N2, row({ body: "b" })))
    ).unwrap();
    expect(compareHlc(next.hlc, stored.hlc)).toBe(1);
    expect(next.seqNum).toBe(seq(2));
  });

  test("an empty store boots to an empty state and a fresh sequence", async () => {
    const { store } = setup(PEER_A);
    const booted = (await openEngine({ peerId: PEER_A, clock: fakeClock(1), store })).unwrap();
    expect(booted.state().size).toBe(0);
    const first = (
      await booted.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body: "a" })))
    ).unwrap();
    expect(first.seqNum).toBe(seq(1));
  });
});

describe("openEngine — boot from persisted state", () => {
  test("opens the rows and reads only the log above their coverage", async () => {
    const stateStore = createMemoryStateStore();
    const { store, engine } = setup(PEER_A, 500, { stateStore });
    (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body: "a" })))).unwrap();
    (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N2, row({ body: "b" })), { local: true })
    ).unwrap();
    expect((await stateStore.isEmpty()).unwrap()).toBe(false);

    const refusing = new StoreFailure({ message: "all() must not be read when state is cached" });
    const log = { ...store, all: () => Promise.resolve(Result.err(refusing)) };
    const booted = (
      await openEngine({ peerId: PEER_A, clock: fakeClock(100), store: log, stateStore })
    ).unwrap();
    expect(body(booted, N1)).toBe("a");
    expect(body(booted, N2)).toBe("b");
    expect(booted.coverage().synced.get(PEER_A)).toBe(seq(1));
    expect(booted.coverage().local.get(PEER_A)).toBe(seq(1));
  });

  test("the log tail above the cache is folded on boot and committed", async () => {
    const stateStore = createMemoryStateStore();
    const { store, engine } = setup(PEER_A, 500, { stateStore });
    (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body: "a" })))).unwrap();

    const behind = (await openEngine({ peerId: PEER_A, clock: fakeClock(600), store })).unwrap();
    (await behind.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ body: "c" })))).unwrap();

    const booted = (
      await openEngine({ peerId: PEER_A, clock: fakeClock(100), store, stateStore })
    ).unwrap();
    expect(body(booted, N1)).toBe("c");
    expect(booted.coverage().synced.get(PEER_A)).toBe(seq(2));
    expect((await stateStore.loadCursors()).unwrap().synced.get(PEER_A)).toBe(seq(2));
    const cached = (await stateStore.loadAll()).unwrap();
    expect(cached.get(NOTES)?.get(N1)?.cells.get(column("body"))?.value).toBe("c");
  });

  test("a commit is row-granular: one update writes one row", async () => {
    const inner = createMemoryStateStore();
    const commits: number[] = [];
    const stateStore: StateStore = {
      ...inner,
      commit: (rows, coverage) => {
        commits.push(rows.length);
        return inner.commit(rows, coverage);
      },
    };
    const { engine } = setup(PEER_A, 500, { stateStore });
    for (const k of ["n1", "n2", "n3"]) {
      (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, key(k), row({ body: k })))).unwrap();
    }
    (await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ body: "z" })))).unwrap();
    expect(commits).toEqual([1, 1, 1, 1]);
  });

  test("a corrupt cache is cleared and rebuilt from the whole log", async () => {
    const inner = createMemoryStateStore();
    let corrupt = true;
    let cleared = 0;
    const stateStore: StateStore = {
      ...inner,
      loadAll: () =>
        corrupt
          ? Promise.resolve(Result.err(new StateCorrupt({ message: "row n1 does not decode" })))
          : inner.loadAll(),
      clear: () => {
        cleared += 1;
        corrupt = false;
        return inner.clear();
      },
    };
    const { store, engine } = setup(PEER_A, 500, { stateStore });
    (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body: "a" })))).unwrap();

    const booted = (
      await openEngine({ peerId: PEER_A, clock: fakeClock(100), store, stateStore })
    ).unwrap();
    expect(cleared).toBe(1);
    expect(body(booted, N1)).toBe("a");
    expect((await inner.loadAll()).unwrap().get(NOTES)?.has(N1)).toBe(true);
    expect((await inner.loadCursors()).unwrap().synced.get(PEER_A)).toBe(seq(1));
  });

  test("a refused commit is reported through onError; the write itself has landed", async () => {
    const stateStore: StateStore = {
      ...createMemoryStateStore(),
      commit: () => Promise.resolve(Result.err(new StoreFailure({ message: "cache full" }))),
    };
    const { store, engine } = setup(PEER_A, 500, { stateStore });
    const errors: EngineError[] = [];
    engine.onError((e) => void errors.push(e));
    const event = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body: "a" })))
    ).unwrap();
    expect(errors.map((e) => `${e._tag}:${e.message}`)).toEqual(["StoreFailure:cache full"]);
    expect((await store.has(event.id)).unwrap()).toBe(true);
  });
});

/**
 * The two-phase write, and what a crash between its halves costs.
 *
 * With no `atomic` the log and the derived state commit separately, in an order the write path
 * guarantees: the event first, the rows and their coverage cursor second. That is what makes two
 * files possible (RFC-0022), where one transaction cannot span them — SQLite commits atomically
 * across attached databases only in rollback-journal mode, and every device here runs WAL.
 *
 * So the question is not whether it tears. It is whether a tear costs anything, and the answer
 * has to be a replay rather than a fact.
 */
describe("openEngine — a write interrupted between its two commits", () => {
  /** A state store whose commit stops working, the way a process does: without warning. */
  const untilKilled = () => {
    const inner = createMemoryStateStore();
    let alive = true;
    const stateStore: StateStore = {
      ...inner,
      commit: (rows, coverage) =>
        alive
          ? inner.commit(rows, coverage)
          : Promise.resolve(Result.ok<void, StoreFailure>(undefined)),
    };
    return { stateStore, kill: () => void (alive = false) };
  };

  test("the event survives, the rows are replayed, and nothing is lost", async () => {
    const { stateStore, kill } = untilKilled();
    const { store, engine } = setup(PEER_A, 500, { stateStore });
    (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body: "before" })))).unwrap();

    // from here the durable half commits and the derived half does not: the tear
    kill();
    (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N2, row({ body: "after" })))).unwrap();

    // the cache is behind the log, which is the only direction this order can produce
    const cached = (await stateStore.loadCursors()).unwrap();
    expect(cached.synced.get(PEER_A)).toBe(seq(1));

    const booted = (
      await openEngine({ peerId: PEER_A, clock: fakeClock(100), store, stateStore })
    ).unwrap();
    expect(body(booted, N1)).toBe("before");
    expect(body(booted, N2)).toBe("after"); // replayed from above the cursor
    expect(booted.coverage().synced.get(PEER_A)).toBe(seq(2));
  });

  test("the cursor never runs ahead of the log, whichever half was interrupted", async () => {
    const { stateStore, kill } = untilKilled();
    const { store, engine } = setup(PEER_A, 500, { stateStore });
    for (const body of ["a", "b", "c"])
      (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, key(body), row({ body })))).unwrap();
    kill();
    (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body: "torn" })))).unwrap();

    const cursor = (await stateStore.loadCursors()).unwrap().synced.get(PEER_A) ?? seq(0);
    const events = (await store.all()).unwrap();
    // a cursor above the log would be a claim to have folded what nobody wrote — the unrecoverable
    // direction, and the reason the durable half commits first
    expect(Number(cursor)).toBeLessThanOrEqual(events.length);
  });
});

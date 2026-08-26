import { Result } from "@syncmesh/result";
import { describe, expect, test } from "bun:test";

import type { RowWrite } from "../state-store.js";

import { type AtomicStores, createEngine } from "../engine.js";
import { StoreFailure, createMemoryEventStore } from "../store.js";
import { CREATE, N1, NOTES, PEER_A, PEER_B, fakeClock, row, setup } from "./fixtures.js";

/** A state store that records commits and can be told to refuse the next one. */
const fakeStateStore = () => {
  const commits: RowWrite[][] = [];
  let refuse = false;
  return {
    commits,
    refuseNext: () => void (refuse = true),
    store: {
      isEmpty: () => Promise.resolve(Result.ok(true)),
      loadAll: () => Promise.resolve(Result.ok(new Map())),
      loadCursors: () => Promise.resolve(Result.ok({ synced: new Map(), local: new Map() })),
      commit: (rows: readonly RowWrite[]) => {
        if (refuse) {
          refuse = false;
          return Promise.resolve(Result.err(new StoreFailure({ message: "disk said no" })));
        }
        commits.push([...rows]);
        return Promise.resolve(Result.ok(undefined));
      },
      clear: () => Promise.resolve(Result.ok(undefined)),
    },
  };
};

describe("EngineOptions.atomic — the log and the state as one write", () => {
  test("mutate and receiveBatch run append and commit inside atomic; folds notify after it resolves", async () => {
    const trace: string[] = [];
    const stateStore = fakeStateStore();
    const store = createMemoryEventStore();
    const atomic = async <T>(fn: (scoped: AtomicStores) => Promise<T>): Promise<T> => {
      trace.push("open");
      const out = await fn({ events: store, state: stateStore.store });
      trace.push("close");
      return out;
    };
    const engine = createEngine({
      peerId: PEER_A,
      clock: fakeClock(100),
      store,
      stateStore: stateStore.store,
      atomic,
    });
    engine.onFoldBatch(() => trace.push("notified"));

    (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })))).unwrap();
    expect(trace).toEqual(["open", "close", "notified"]); // the fold reaches listeners only once committed
    expect(stateStore.commits).toHaveLength(1);

    const author = setup(PEER_B, 50);
    const event = (
      await author.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "b" })))
    ).unwrap();
    trace.length = 0;
    (await engine.receiveBatch([{ event }])).unwrap();
    expect(trace).toEqual(["open", "close", "notified"]);
    expect(stateStore.commits).toHaveLength(2);
  });

  test("a state commit that fails inside atomic fails the write: the transaction owner rolls back, no notification", async () => {
    const stateStore = fakeStateStore();
    // an atomic like openStores': anything thrown inside aborts the whole transaction
    const appended: string[] = [];
    const store = createMemoryEventStore();
    const atomic = async <T>(fn: (scoped: AtomicStores) => Promise<T>): Promise<T> => {
      const events = {
        ...store,
        append: async (entry: Parameters<typeof store.append>[0]) => {
          const r = await store.append(entry);
          appended.push(String(entry.event.id));
          return r;
        },
      };
      return fn({ events, state: stateStore.store });
    };
    const engine = createEngine({
      peerId: PEER_A,
      clock: fakeClock(100),
      store,
      stateStore: stateStore.store,
      atomic,
    });
    let notified = 0;
    engine.onFoldBatch(() => void (notified += 1));

    stateStore.refuseNext();
    const written = await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })));
    expect(written.isErr() && written.error._tag).toBe("StoreFailure");
    expect(written.isErr() && written.error.message).toBe("disk said no"); // the store's own failure, as itself
    expect(appended).toHaveLength(1); // the append ran inside the transaction the owner now rolls back
    expect(notified).toBe(0);
  });
});

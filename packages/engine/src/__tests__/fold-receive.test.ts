import { readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import type { FoldBatch, SyncEvent } from "../index.js";

import { CREATE, key, N1, NOTES, PEER_B, row, setup } from "./fixtures.js";

const N2 = key("n2");

const collect = <T>() => {
  const seen: T[] = [];
  return { seen, push: (x: T) => void seen.push(x) };
};

describe("fold → one FoldBatch", () => {
  test("a mutate emits exactly one batch with the exact keys it touched", async () => {
    const { engine } = setup();
    const batches = collect<FoldBatch>();
    engine.onFoldBatch(batches.push);
    await engine.mutate(CREATE, (tx) => {
      tx.insert(NOTES, N1, row({ title: "a" }));
      tx.update(NOTES, N2, row({ title: "b" }));
    });
    expect(batches.seen).toHaveLength(1);
    const batch = batches.seen[0];
    expect(batch?.source).toBe("local");
    expect(batch?.eventCount).toBe(1);
    expect([...(batch?.writeTables ?? [])]).toEqual([NOTES]);
    expect([...(batch?.writeKeys.get(NOTES) ?? [])]).toEqual([N1, N2]);
  });

  test("unsubscribe stops delivery", async () => {
    const { engine } = setup();
    const batches = collect<FoldBatch>();
    const off = engine.onFoldBatch(batches.push);
    await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })));
    off();
    await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "b" })));
    expect(batches.seen).toHaveLength(1);
  });
});

describe("receive / receiveBatch", () => {
  const authored = async (n: number) => {
    const b = setup(PEER_B, 500);
    const events: SyncEvent[] = [];
    for (let i = 0; i < n; i++) {
      events.push(
        (
          await b.engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ [`c${i}`]: i })))
        ).unwrap(),
      );
    }
    return events;
  };

  test("a batch of N remote events folds once and lands in state and store", async () => {
    const { engine, store } = setup();
    const batches = collect<FoldBatch>();
    engine.onFoldBatch(batches.push);
    const events = await authored(3);
    const report = (await engine.receiveBatch(events)).unwrap();
    expect(report).toEqual({ folded: 3, skipped: 0 });
    expect(batches.seen).toHaveLength(1);
    expect(batches.seen[0]?.source).toBe("remote");
    expect(batches.seen[0]?.eventCount).toBe(3);
    expect(readRow(engine.state(), NOTES, N1)).toEqual(row({ c0: 0, c1: 1, c2: 2 }));
    expect((await store.all()).unwrap()).toHaveLength(3);
  });

  test("duplicates — within a batch or already stored — are skipped, not refolded", async () => {
    const { engine } = setup();
    const batches = collect<FoldBatch>();
    engine.onFoldBatch(batches.push);
    const [e] = await authored(1);
    if (e === undefined) throw new Error("fixture");
    expect((await engine.receiveBatch([e, e])).unwrap()).toEqual({ folded: 1, skipped: 1 });
    expect((await engine.receive(e)).unwrap()).toEqual({ folded: 0, skipped: 1 });
    expect(batches.seen).toHaveLength(1);
  });

  test("own events and empty batches are no-ops", async () => {
    const { engine, store } = setup();
    const batches = collect<FoldBatch>();
    engine.onFoldBatch(batches.push);
    const mine = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })))
    ).unwrap();
    expect((await engine.receive(mine)).unwrap()).toEqual({ folded: 0, skipped: 1 });
    expect((await engine.receiveBatch([])).unwrap()).toEqual({ folded: 0, skipped: 0 });
    expect(batches.seen).toHaveLength(1);
    expect((await store.all()).unwrap()).toHaveLength(1);
  });

  test("receiving ratchets the clock: the next local write is stamped after the remote one", async () => {
    const { engine } = setup(undefined, 100);
    const [remote] = await authored(1);
    if (remote === undefined) throw new Error("fixture");
    await engine.receive(remote);
    const mine = (
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "x" })))
    ).unwrap();
    expect(mine.hlc[0].epochMilliseconds).toBe(500);
    expect(mine.hlc[1]).toBeGreaterThan(remote.hlc[1]);
  });

  test("onOutbound fires for synced writes only", async () => {
    const { engine } = setup();
    const out = collect<SyncEvent>();
    engine.onOutbound(out.push);
    await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })));
    await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ draft: true })), {
      local: true,
    });
    expect(out.seen.map((e) => Number(e.seqNum))).toEqual([1]);
  });
});

describe("convergence — two engines, offline edits to different fields", () => {
  test("exchanging events in either order lands both edits on both sides", async () => {
    const a = setup(undefined, 100);
    const b = setup(PEER_B, 100);
    const seed = (
      await a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t", body: "b" })))
    ).unwrap();
    await b.engine.receive(seed);

    const fromA = (
      await a.engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "A's title" })))
    ).unwrap();
    const fromB = (
      await b.engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ body: "B's body" })))
    ).unwrap();

    await a.engine.receive(fromB);
    await b.engine.receive(fromA);

    const merged = row({ title: "A's title", body: "B's body" });
    expect(readRow(a.engine.state(), NOTES, N1)).toEqual(merged);
    expect(readRow(b.engine.state(), NOTES, N1)).toEqual(merged);
  });
});

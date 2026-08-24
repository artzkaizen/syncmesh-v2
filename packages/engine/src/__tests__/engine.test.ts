import { readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { fakeClock, N1, NOTES, PEER_A, procedure, row } from "./fixtures.js";

const setup = () => {
  const store = createMemoryEventStore();
  const clock = fakeClock(100);
  const engine = createEngine({ peerId: PEER_A, clock, store });
  return { store, clock, engine };
};

const CREATE = procedure("notes.create");

describe("engine.mutate", () => {
  test("records the tx as changes, stamps, numbers from 1, appends, folds", async () => {
    const { engine, store } = setup();
    const event = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })))
    ).unwrap();
    expect(Number(event.seqNum)).toBe(1);
    expect(String(event.id)).toBe(`${PEER_A}-1`);
    expect(event.changes).toEqual([
      { kind: "insert", table: NOTES, key: N1, row: row({ title: "a" }) },
    ]);
    expect((await store.has(event.id)).unwrap()).toBe(true);
    expect(readRow(engine.state(), NOTES, N1)).toEqual(row({ title: "a" }));
  });

  test("consecutive mutations get consecutive sequence numbers and increasing hlcs", async () => {
    const { engine } = setup();
    const a = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })))
    ).unwrap();
    const b = (
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "b" })))
    ).unwrap();
    expect([a.seqNum, b.seqNum].map(Number)).toEqual([1, 2]);
    expect(b.hlc[1]).toBeGreaterThan(a.hlc[1]);
    expect(readRow(engine.state(), NOTES, N1)).toEqual(row({ title: "b" }));
  });

  test("an empty tx is Err(EmptyMutation): nothing ticks, nothing appends", async () => {
    const { engine, store, clock } = setup();
    const before = clock.last();
    const r = await engine.mutate(CREATE, () => {});
    expect(r.isErr() && r.error._tag).toBe("EmptyMutation");
    expect(clock.last()).toBe(before);
    expect((await store.all()).unwrap()).toHaveLength(0);
  });

  test("re-reads the store's lastSeq on every mutate — a sibling tab may have allocated", async () => {
    const { engine, store } = setup();
    const first = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })))
    ).unwrap();
    const sibling = createEngine({ peerId: PEER_A, clock: fakeClock(200), store });
    const theirs = (
      await sibling.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "s" })))
    ).unwrap();
    const next = (
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "b" })))
    ).unwrap();
    expect([first.seqNum, theirs.seqNum, next.seqNum].map(Number)).toEqual([1, 2, 3]);
  });

  test("local events count in their own sequence namespace", async () => {
    const { engine } = setup();
    const synced = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })))
    ).unwrap();
    const local = (
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ draft: true })), {
        local: true,
      })
    ).unwrap();
    const synced2 = (
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "b" })))
    ).unwrap();
    expect([synced.seqNum, local.seqNum, synced2.seqNum].map(Number)).toEqual([1, 1, 2]);
    expect(local.local).toBe(true);
    expect(synced.local).toBeUndefined();
  });

  test("partition is carried on the event", async () => {
    const { engine } = setup();
    // SAFETY: test fixture; partition key rules arrive with E08
    const partition = "org:acme" as never;
    const event = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })), { partition })
    ).unwrap();
    expect(event.partition).toBe(partition);
  });
});

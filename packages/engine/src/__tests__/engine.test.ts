import { readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { createEngine } from "../engine.js";
import {
  CREATE,
  fakeClock,
  key,
  N1,
  NOTES,
  PEER_A,
  PEER_B,
  procedure,
  row,
  setup,
} from "./fixtures.js";

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
    // SAFETY: test fixture; partition keys are `kind:id` text and the schema owns the rules
    const partition = "org:acme" as never;
    const event = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })), { partition })
    ).unwrap();
    expect(event.partition).toBe(partition);
  });
});

/**
 * Telling a row that was deleted from one this device has never held.
 *
 * The two are the same empty answer to every read above the record — `readRow` here, and the
 * app's own SQLite table on a device, which the storage projection hard-deletes the row out of —
 * so a detail screen watching a peer delete an issue could only report it as never having been
 * here. Two engines and one delete is the smallest arrangement that has both facts in it at once,
 * which is what makes the distinction testable rather than merely stated.
 */
describe("engine.deletedAt", () => {
  const REMOVE = procedure("notes.delete");
  const N2 = key("n2");

  /** One device writes a note and then deletes it; the events are what the other one receives. */
  const writtenThenDeleted = async () => {
    const a = setup(PEER_A, 100);
    const wrote = (
      await a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })))
    ).unwrap();
    const deleted = (await a.engine.mutate(REMOVE, (tx) => tx.delete(NOTES, N1))).unwrap();
    return [wrote, deleted];
  };

  test("the receiving device tells a deleted row from one it never held", async () => {
    const b = setup(PEER_B, 500);
    const events = await writtenThenDeleted();
    expect((await b.engine.receiveBatch(events.map((event) => ({ event })))).unwrap().folded).toBe(
      2,
    );

    // the bug, stated as an assertion: the row read cannot separate the two cases, and neither
    // can anything built on it
    expect(readRow(b.engine.state(), NOTES, N1)).toBeUndefined();
    expect(readRow(b.engine.state(), NOTES, N2)).toBeUndefined();

    // the tombstone can, and it names the device that wrote the delete
    expect(b.engine.deletedAt(NOTES, N1)?.peer).toBe(PEER_A);
    expect(b.engine.deletedAt(NOTES, N2)).toBeUndefined();
  });

  test("a visible row is not deleted, whether or not it carries a tombstone", async () => {
    const b = setup(PEER_B, 500);
    const events = await writtenThenDeleted();
    (await b.engine.receiveBatch(events.map((event) => ({ event })))).unwrap();
    expect(b.engine.deletedAt(NOTES, N1)).toBeDefined();

    // an edit stamped above the delete is the CRDT's answer to a concurrent pair: the row is back
    // on screen, so "deleted" is no longer true of it even though the record still holds the stamp
    (await b.engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "b" })))).unwrap();
    expect(readRow(b.engine.state(), NOTES, N1)).toEqual(row({ title: "b" }));
    expect(b.engine.deletedAt(NOTES, N1)).toBeUndefined();
  });

  test("a row this device wrote and never deleted answers undefined", async () => {
    const { engine } = setup();
    (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "a" })))).unwrap();
    expect(engine.deletedAt(NOTES, N1)).toBeUndefined();
  });
});

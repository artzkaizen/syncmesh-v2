import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { createMemoryEventStore } from "../store.js";
import { CREATE, N1, NOTES, PEER_A, PEER_B, row, seq, setup } from "./fixtures.js";

const LATER = Temporal.Instant.fromEpochMilliseconds(9e12);

/** Three synced writes and one local one by `PEER_A`, as the entries its store holds. */
const written = async () => {
  const { engine, store } = setup();
  for (const title of ["a", "b", "c"])
    (await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title })))).unwrap();
  (
    await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ draft: true })), {
      local: true,
    })
  ).unwrap();
  return (await store.all()).unwrap();
};

describe("the memory event store", () => {
  test("lastSeq is the highest sequence per scope, whatever order the events arrive in", async () => {
    const entries = await written();
    const store = createMemoryEventStore();
    (await store.appendBatch([...entries].reverse())).unwrap();
    (await store.append(entries[0]!)).unwrap(); // a duplicate is not a new head
    expect((await store.lastSeq(PEER_A, "synced")).unwrap()).toBe(seq(3));
    expect((await store.lastSeq(PEER_A, "local")).unwrap()).toBe(seq(1));
    expect((await store.lastSeq(PEER_B, "synced")).unwrap()).toBeUndefined();
  });

  test("lastSeq does not fall when compaction removes every event it was read from", async () => {
    const store = createMemoryEventStore();
    (await store.appendBatch(await written())).unwrap();
    const removed = await store.compactBelow(new Map([[PEER_A, seq(3)]]), "synced", LATER);
    expect(removed.unwrap()).toBe(3);
    expect((await store.lastSeq(PEER_A, "synced")).unwrap()).toBe(seq(3));
    expect((await store.lastSeq(PEER_A, "local")).unwrap()).toBe(seq(1));
  });
});

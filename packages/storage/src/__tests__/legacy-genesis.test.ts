import { parseAdapterId, parseLineageId, type DocChange } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { A, B, BODY, N1, NOTES, entry } from "../driver-tests/fixtures.js";
import { sqlEventStore } from "../event-store.js";
import { openPair } from "./pair.js";

/**
 * A log that holds a genesis written under the lineage rule before RFC-0023 §16.1 (key 5 `true`)
 * still reads: the wire decodes one as `legacy`, and admission is what refuses it.
 */
const legacy: DocChange = {
  kind: "doc",
  table: NOTES,
  key: N1,
  column: BODY,
  adapter: parseAdapterId("loro@1").unwrap(),
  lineage: parseLineageId("0f".repeat(16)).unwrap(),
  update: { bytes: Uint8Array.of(1) },
  genesis: true,
  legacy: true,
};

describe("a stored legacy genesis", () => {
  test("every read of the log hands it back, flagged legacy, instead of failing", async () => {
    const store = (await sqlEventStore(await openPair())).unwrap();
    const held = entry(A, 1, 100);
    const old = { ...held, event: { ...held.event, changes: [...held.event.changes, legacy] } };
    (await store.appendBatch([old, entry(B, 1, 150)])).unwrap();
    const all = (await store.all()).unwrap();
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.event.peerId === A)?.event.changes[1]).toEqual(legacy);
    expect((await store.allSince(new Map())).unwrap()).toHaveLength(2);
  });
});

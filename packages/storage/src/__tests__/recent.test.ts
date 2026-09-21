import { parsePartitionKey } from "@syncmesh/kernel";
import { encodeEventCore } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { A, B, entry, hlc } from "../driver-tests/fixtures.js";
import { sqlEventStore } from "../event-store.js";
import { openPair } from "./pair.js";

/**
 * The one statement per dialect behind `Engine.recentEvents`, over real SQL (gap 1).
 *
 * The engine's own suite proves the shape of a header; what can only be proved here is that the
 * statement orders by the stamp index rather than by the primary key, that its cursor pages
 * without an overlap, and that it never selects a core — `length(core)` is a number, and a number
 * is all that comes back.
 */

const ACME = parsePartitionKey("org:acme").unwrap();

const open = async () => {
  const driver = await openPair();
  return (await sqlEventStore(driver)).unwrap();
};

/** Two authors interleaved in time, so stamp order and `(peer, seq)` order cannot agree. */
const logged = async () => {
  const store = await open();
  const entries = [
    entry(A, 1, 100),
    entry(B, 1, 150, { partition: ACME }),
    entry(A, 2, 200),
    entry(A, 1, 250, { local: true }),
    entry(B, 2, 300),
  ];
  (await store.appendBatch(entries)).unwrap();
  return { store, entries };
};

describe("the stamp-ordered read", () => {
  test("hands back the tail newest first, across authors and both scopes", async () => {
    const { store, entries } = await logged();
    const page = (await store.recent!({})).unwrap();

    // by stamp, which interleaves the two authors — `(peer, seq)` order would not
    expect(page.map((header) => header.id)).toEqual(
      [...entries].reverse().map((stored) => stored.event.id),
    );
    // the local write is in it, and it is the one `allSince` cannot carry
    expect(page.filter((header) => header.local)).toHaveLength(1);
    expect((await store.allSince(new Map())).unwrap()).toHaveLength(4);
  });

  test("a cursor pages it without repeating a row or losing one", async () => {
    const { store } = await logged();
    const first = (await store.recent!({ limit: 2 })).unwrap();
    const second = (await store.recent!({ limit: 2, before: first.at(-1)!.hlc })).unwrap();
    const third = (await store.recent!({ limit: 2, before: second.at(-1)!.hlc })).unwrap();
    const past = (await store.recent!({ before: third.at(-1)!.hlc })).unwrap();

    const walked = [...first, ...second, ...third].map((header) => header.id);
    expect(new Set(walked).size).toBe(5);
    expect(walked).toEqual((await store.recent!({})).unwrap().map((header) => header.id));
    expect(past).toEqual([]);
  });

  test("a header weighs the core and never selects it", async () => {
    const { store, entries } = await logged();
    const [newest] = (await store.recent!({ limit: 1 })).unwrap();

    expect(newest?.bytes).toBe(encodeEventCore(entries[4]!.event).length);
    expect(newest?.hlc).toEqual(hlc(300));
    // absent, because naming a table here means reading the core back — the one thing this read
    // declines to do
    expect(newest?.tables).toBeUndefined();
  });

  test("the stored partition comes back as a key, and a global row as nothing", async () => {
    const { store } = await logged();
    const page = (await store.recent!({})).unwrap();
    const withPartition = page.filter((header) => header.partition !== undefined);

    expect(withPartition.map((header) => header.partition)).toEqual([ACME]);
  });

  test("an empty log has an empty tail rather than a failure", async () => {
    const store = await open();
    expect((await store.recent!({})).unwrap()).toEqual([]);
  });
});

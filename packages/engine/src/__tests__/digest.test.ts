import type { RowKey, RowRecord } from "@syncmesh/kernel";

import { readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { divergentRows, divergentTables, rowDigest } from "../digest.js";
import { CREATE, N1, NOTES, PEER_A, PEER_B, key, row, setup, table } from "./fixtures.js";

const OTHER = table("other");
const N2 = key("n2");

/** Two engines that write the same rows in the opposite order — same facts, different histories. */
const pair = async () => {
  const a = setup(PEER_A, 100);
  const b = setup(PEER_B, 200);
  return { a, b };
};

const write = (engine: ReturnType<typeof setup>["engine"], k: RowKey, title: string) =>
  engine.mutate(CREATE, (tx) => tx.insert(NOTES, k, row({ title })));

describe("digests", () => {
  test("order-free: the same rows digest the same however they were written", async () => {
    const { a, b } = await pair();
    (await write(a.engine, N1, "one")).unwrap();
    (await write(a.engine, N2, "two")).unwrap();
    (await write(b.engine, N2, "two")).unwrap();
    (await write(b.engine, N1, "one")).unwrap();
    // the stamps differ (different peers, different clocks), so the digests must too …
    expect(a.engine.digest().get(NOTES)).not.toBe(b.engine.digest().get(NOTES));

    // … but a digest of the same records, summed in any order, is the same number
    const records = [...(a.engine.state().get(NOTES) ?? new Map<RowKey, RowRecord>()).values()];
    const forward = records.map(rowDigest);
    const backward = [...records].reverse().map(rowDigest);
    const total = (values: readonly bigint[]) => values.reduce((n, v) => n + v, 0n);
    expect(total(forward)).toBe(total(backward));
  });

  test("an absent table and an empty one are the same fact", async () => {
    const { a } = await pair();
    expect(a.engine.digest().has(NOTES)).toBe(false);
    (await write(a.engine, N1, "one")).unwrap();
    expect(a.engine.digest().has(NOTES)).toBe(true);
    expect(divergentTables(a.engine.digest(), new Map())).toEqual([NOTES]);
    expect(divergentTables(new Map(), new Map())).toEqual([]);
  });

  test("a duplicated row changes the digest — what an XOR would hide", async () => {
    const { a } = await pair();
    (await write(a.engine, N1, "one")).unwrap();
    const record = a.engine.state().get(NOTES)?.get(N1);
    expect(record).toBeDefined();
    // SAFETY: the write above put this row in state, and the assertion just proved it
    const one = rowDigest(record as RowRecord);
    // a sum counts the second copy; an XOR would cancel it and call the table identical
    expect((one + one) % (1n << 64n)).not.toBe(one);
  });

  test("divergence narrows: which table, then which rows", async () => {
    const { a, b } = await pair();
    (await write(a.engine, N1, "same")).unwrap();
    (await b.engine.receiveBatch((await a.engine.eventsSince(new Map())).unwrap())).unwrap();
    expect(divergentTables(a.engine.digest(), b.engine.digest())).toEqual([]);

    // b alone learns another row, in a table a has never heard of
    (
      await b.engine.mutate(CREATE, (tx) => tx.insert(OTHER, N2, row({ title: "b only" })))
    ).unwrap();
    const tables = divergentTables(a.engine.digest(), b.engine.digest());
    expect(tables).toEqual([OTHER]);
    expect(divergentRows(a.engine.rowDigests(OTHER), b.engine.rowDigests(OTHER))).toEqual([N2]);
    expect(divergentRows(a.engine.rowDigests(NOTES), b.engine.rowDigests(NOTES))).toEqual([]);
  });
});

describe("repair", () => {
  test("merging the other side's records heals both ways and adopts no cursors", async () => {
    const { a, b } = await pair();
    (await write(a.engine, N1, "from a")).unwrap();
    (await write(b.engine, N2, "from b")).unwrap();

    const cursorsBefore = new Map(a.engine.coverage().synced);
    const keys = divergentRows(a.engine.rowDigests(NOTES), b.engine.rowDigests(NOTES));
    expect(keys).toEqual([N1, N2]);

    // each side takes what the other holds — the ordinary merge, so direction does not matter
    await a.engine.repairRows(NOTES, b.engine.rowRecords(NOTES, keys));
    await b.engine.repairRows(NOTES, a.engine.rowRecords(NOTES, keys));
    expect(divergentTables(a.engine.digest(), b.engine.digest())).toEqual([]);
    expect(readRow(a.engine.state(), NOTES, N2)).toEqual(row({ title: "from b" }));
    expect(readRow(b.engine.state(), NOTES, N1)).toEqual(row({ title: "from a" }));

    // a repaired row says what it is, never that this peer holds the events behind it
    expect(a.engine.coverage().synced.get(PEER_B)).toBe(cursorsBefore.get(PEER_B));
    expect((await a.engine.eventsSince(new Map())).unwrap()).toHaveLength(1);
  });

  test("a repair notifies live queries once, with the keys it touched", async () => {
    const { a, b } = await pair();
    (await write(b.engine, N1, "from b")).unwrap();
    const batches: { source: string; keys: readonly RowKey[] }[] = [];
    a.engine.onFoldBatch(
      (batch) =>
        void batches.push({
          source: batch.source,
          keys: [...(batch.writeKeys.get(NOTES) ?? new Set<RowKey>())],
        }),
    );
    await a.engine.repairRows(NOTES, b.engine.rowRecords(NOTES, [N1]));
    expect(batches).toEqual([{ source: "repair", keys: [N1] }]);

    await a.engine.repairRows(NOTES, []); // nothing to heal is not an event
    expect(batches).toHaveLength(1);
  });
});

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures: `RowKey`, `ColumnName` and `TableName` are brands over `string`, and a fixture naming one is stating what it is rather than asserting anything about data it read */

import type { ColumnName, RowKey, RowRecord, Stamp, State, TableName } from "@syncmesh/kernel";

import { getRecord, hlcOf, mergeRecord, parsePeerId } from "@syncmesh/kernel";
import { encodeRecord } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { lazyTable } from "../lazy-state.js";

const PEER = parsePeerId("aa".repeat(32)).unwrap();

const stamp = (ms: number): Stamp => ({ hlc: hlcOf(ms, 0), peer: PEER });

const record = (body: string, ms: number): RowRecord => ({
  cells: new Map([["body" as ColumnName, { value: body, stamp: stamp(ms) }]]),
  writeStamp: stamp(ms),
});

/** A table of `n` rows, as the bytes the state store would have written for them. */
const stored = (n: number) =>
  new Map(
    Array.from({ length: n }, (_, i) => [
      `k${String(i)}` as RowKey,
      encodeRecord(record(`body ${String(i)}`, 1000 + i)),
    ]),
  );

const bodyOf = (found: RowRecord | undefined) => found?.cells.get("body" as ColumnName)?.value;

describe("lazyTable", () => {
  test("answers size, has and keys without decoding anything", () => {
    let decodes = 0;
    const bytes = new Map(stored(3));
    const counting: ReadonlyMap<RowKey, Uint8Array> = {
      ...bytes,
      size: bytes.size,
      has: (key: RowKey) => bytes.has(key),
      keys: () => bytes.keys(),
      values: () => bytes.values(),
      entries: () => bytes.entries(),
      forEach: bytes.forEach.bind(bytes),
      [Symbol.iterator]: () => bytes[Symbol.iterator](),
      get: (key: RowKey) => {
        decodes += 1;
        return bytes.get(key);
      },
    };
    const table = lazyTable(counting);

    expect(table.size).toBe(3);
    expect(table.has("k1" as RowKey)).toBe(true);
    expect([...table.keys()]).toEqual(["k0", "k1", "k2"] as RowKey[]);
    expect(decodes).toBe(0);
  });

  test("decodes a row on first get and remembers it", () => {
    const table = lazyTable(stored(2));
    const first = table.get("k1" as RowKey);
    expect(bodyOf(first)).toBe("body 1");
    // the same object back, rather than a second decode of the same bytes
    expect(table.get("k1" as RowKey)).toBe(first);
  });

  test("reads an absent key as absent rather than decoding", () => {
    expect(lazyTable(stored(1)).get("nope" as RowKey)).toBeUndefined();
  });

  test("copies into a plain Map with every row decoded — the path `withRecord` takes", () => {
    const copied = new Map(lazyTable(stored(4)));
    expect(copied.size).toBe(4);
    expect(bodyOf(copied.get("k3" as RowKey))).toBe("body 3");
  });

  test("iterates entries, values and forEach over decoded records", () => {
    const table = lazyTable(stored(3));
    expect([...table.entries()].map(([, r]) => bodyOf(r))).toEqual(["body 0", "body 1", "body 2"]);
    expect([...table.values()].map(bodyOf)).toEqual(["body 0", "body 1", "body 2"]);
    const seen: string[] = [];
    table.forEach((r, key) => seen.push(`${String(key)}=${String(bodyOf(r))}`));
    expect(seen).toEqual(["k0=body 0", "k1=body 1", "k2=body 2"]);
  });

  test("keeps the stamps a merge decides on", () => {
    const found = lazyTable(stored(1)).get("k0" as RowKey);
    expect(found?.writeStamp?.peer).toBe(PEER);
    expect(found?.cells.get("body" as ColumnName)?.stamp.hlc[0].epochMilliseconds).toBe(1000);
  });

  test("throws rather than reading a damaged record as an absent row", () => {
    const table = lazyTable(new Map([["k0" as RowKey, Uint8Array.of(1, 2, 3, 4)]]));
    expect(() => table.get("k0" as RowKey)).toThrow(/will not decode/);
  });

  test("folds a write over a lazy table and leaves its other rows intact", () => {
    const NOTES = "notes" as TableName;
    const state: State = new Map([[NOTES, lazyTable(stored(3))]]);

    // the shape `applyChange` hands to `mergeRecord` — one row, by key, as a fold does
    const next = mergeRecord(state, NOTES, "k1" as RowKey, record("edited", 9999));

    expect(bodyOf(getRecord(next, NOTES, "k1" as RowKey))).toBe("edited");
    expect(bodyOf(getRecord(next, NOTES, "k0" as RowKey))).toBe("body 0");
    expect(bodyOf(getRecord(next, NOTES, "k2" as RowKey))).toBe("body 2");
    // and the state it was folded over is unchanged, because a fold returns a new one
    expect(bodyOf(getRecord(state, NOTES, "k1" as RowKey))).toBe("body 1");
  });
});

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures: `RowKey`, `ColumnName` and `TableName` are brands over `string`, and a fixture naming one is stating what it is rather than asserting anything about data it read */

import type { ColumnName, RowKey, RowRecord, Stamp, State, TableName } from "@syncmesh/kernel";

import { getRecord, hlcOf, mergeRecord, parsePeerId } from "@syncmesh/kernel";
import { encodeRecord } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { WARM_ROWS, packedTable } from "../packed-rows.js";

const PEER = parsePeerId("aa".repeat(32)).unwrap();
const NOTES = "notes" as TableName;

const stamp = (ms: number): Stamp => ({ hlc: hlcOf(ms, 0), peer: PEER });

const record = (body: string, ms: number): RowRecord => ({
  cells: new Map([["body" as ColumnName, { value: body, stamp: stamp(ms) }]]),
  writeStamp: stamp(ms),
});

const key = (i: number) => `k${String(i)}` as RowKey;

/** A table of `n` rows, as the bytes the state store would have written for them. */
const stored = (n: number) =>
  new Map(
    Array.from({ length: n }, (_, i) => [
      key(i),
      encodeRecord(record(`body ${String(i)}`, 1000 + i)),
    ]),
  );

const body = (found: RowRecord | undefined) => found?.cells.get("body" as ColumnName)?.value;

describe("packedTable", () => {
  test("answers size, has and keys from the bytes", () => {
    const table = packedTable(stored(3));
    expect(table.size).toBe(3);
    expect(table.has(key(1))).toBe(true);
    expect([...table.keys()]).toEqual([key(0), key(1), key(2)]);
  });

  test("decodes a row on first get and hands back that object while it stays warm", () => {
    const table = packedTable(stored(2));
    const first = table.get(key(1));
    expect(body(first)).toBe("body 1");
    expect(table.get(key(1))).toBe(first);
  });

  test("reads an absent key as absent", () => {
    expect(packedTable(stored(1)).get("nope" as RowKey)).toBeUndefined();
  });

  test("iterates entries, values and forEach over decoded records", () => {
    const table = packedTable(stored(3));
    expect([...table.entries()].map(([, r]) => body(r))).toEqual(["body 0", "body 1", "body 2"]);
    expect([...table.values()].map(body)).toEqual(["body 0", "body 1", "body 2"]);
    const seen: [RowKey, unknown][] = [];
    table.forEach((r, k) => seen.push([k, body(r)]));
    expect(seen).toEqual([
      [key(0), "body 0"],
      [key(1), "body 1"],
      [key(2), "body 2"],
    ]);
  });

  test("keeps the stamps a merge decides on", () => {
    const found = packedTable(stored(1)).get(key(0));
    expect(found?.writeStamp?.peer).toBe(PEER);
    expect(found?.cells.get("body" as ColumnName)?.stamp.hlc[0].epochMilliseconds).toBe(1000);
  });

  test("throws rather than reading a damaged record as an absent row", () => {
    const table = packedTable(new Map([[key(0), Uint8Array.of(1, 2, 3, 4)]]));
    expect(() => table.get(key(0))).toThrow(/will not decode/);
  });

  test("folds a write over a packed table and leaves its other rows and versions intact", () => {
    const state: State = new Map([[NOTES, packedTable(stored(3))]]);

    const next = mergeRecord(state, NOTES, key(1), record("edited", 9999));

    expect(body(getRecord(next, NOTES, key(1)))).toBe("edited");
    expect(body(getRecord(next, NOTES, key(0)))).toBe("body 0");
    expect(body(getRecord(next, NOTES, key(2)))).toBe("body 2");
    expect(body(getRecord(state, NOTES, key(1)))).toBe("body 1");
  });

  test("packs the oldest rows past the warm limit and still reads every one", () => {
    let state: State = new Map([[NOTES, packedTable(new Map())]]);
    const rows = WARM_ROWS + 100;
    for (let i = 0; i < rows; i += 1)
      state = mergeRecord(state, NOTES, key(i), record(`body ${String(i)}`, 1000 + i));
    const table = state.get(NOTES);
    expect(table?.size).toBe(rows);
    expect(body(table?.get(key(0)))).toBe("body 0");
    expect(body(table?.get(key(rows - 1)))).toBe(`body ${String(rows - 1)}`);
    expect([...(table?.values() ?? [])].every((r) => r.writeStamp?.peer === PEER)).toBe(true);
  });
});

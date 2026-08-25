import type { ColumnName, Logical, RowRecord, Stamp } from "@syncmesh/kernel";

import { compareStamp, parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { decodeRecord, encodeRecord } from "../record-codec.js";

const peer = parsePeerId("a".repeat(64)).unwrap();
const stamp = (ms: number, logical = 0): Stamp => ({
  // SAFETY: test fixture; a small non-negative integer is a valid Logical
  hlc: [Temporal.Instant.fromEpochMilliseconds(ms), logical as Logical],
  peer,
});
// SAFETY: test fixture; column naming rules are not under test here
const col = (name: string) => name as ColumnName;

const record: RowRecord = {
  cells: new Map([
    [col("title"), { value: "hi", stamp: stamp(1) }],
    [col("tags"), { value: ["a", { b: 1 }], stamp: stamp(2, 3) }],
    [col("blob"), { value: Uint8Array.of(1, 2), stamp: stamp(3) }],
    [col("gone"), { value: null, stamp: stamp(4) }],
  ]),
  writeStamp: stamp(1),
  deleteStamp: stamp(0),
};

describe("record codec", () => {
  test("round-trips cells, nested json, bytes and both stamps byte-identically", () => {
    const decoded = decodeRecord(encodeRecord(record)).unwrap();
    expect(encodeRecord(decoded)).toEqual(encodeRecord(record));
    expect(decoded.cells.get(col("tags"))?.value).toEqual(["a", { b: 1 }]);
    expect(decoded.cells.get(col("blob"))?.value).toEqual(Uint8Array.of(1, 2));
    expect(Number(decoded.cells.get(col("tags"))?.stamp.hlc[1])).toBe(3);
    expect(decoded.writeStamp && compareStamp(decoded.writeStamp, stamp(1))).toBe(0);
    expect(decoded.deleteStamp?.hlc[0].epochMilliseconds).toBe(0);
  });

  test("absent stamps stay absent", () => {
    const decoded = decodeRecord(encodeRecord({ cells: new Map() })).unwrap();
    expect(decoded).not.toHaveProperty("writeStamp");
    expect(decoded).not.toHaveProperty("deleteStamp");
    expect(decoded.cells.size).toBe(0);
  });

  test("damage is a MalformedRecord, never a throw", () => {
    const tag = (bytes: Uint8Array) => {
      const r = decodeRecord(bytes);
      return r.isErr() ? r.error._tag : "ok";
    };
    expect(tag(Uint8Array.of(0x83, 0x00, 0xf6, 0xf6))).toBe("MalformedRecord");
    expect(tag(Uint8Array.of(0xff, 0x01))).toBe("MalformedRecord");
    expect(tag(encodeRecord(record).subarray(0, 10))).toBe("MalformedRecord");
  });
});

describe("partition on the record", () => {
  test("round-trips, and absent stays absent", () => {
    const acme = parsePartitionKey("org:acme").unwrap();
    const decoded = decodeRecord(encodeRecord({ ...record, partition: acme })).unwrap();
    expect(decoded.partition).toBe(acme);
    expect(decodeRecord(encodeRecord(record)).unwrap()).not.toHaveProperty("partition");
  });
});

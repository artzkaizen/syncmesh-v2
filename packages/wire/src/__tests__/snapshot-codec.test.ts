import type {
  Cell,
  ColumnName,
  KeyedRecord,
  RowKey,
  RowRecord,
  Stamp,
  TableName,
} from "@syncmesh/kernel";

import { hlcOf, parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { encodeCbor, type CborValue } from "../cbor.js";
import { hexToBytes } from "../hex.js";
import { encodeRecord } from "../record-codec.js";
import {
  decodeSnapshotPage,
  decodeSnapshotRows,
  encodeSnapshotPage,
  encodeSnapshotRows,
} from "../snapshot-codec.js";

const PEER = parsePeerId("a".repeat(64)).unwrap();
const OTHER = parsePeerId("b".repeat(64)).unwrap();
const ACME = parsePartitionKey("org:acme").unwrap();

// SAFETY: test fixture; table, column and key naming rules are owned by the schema
const NOTES = "notes" as TableName;
const column = (name: string) => {
  // SAFETY: test fixture; column naming rules are owned by the schema
  return name as ColumnName;
};
const key = (value: string) => {
  // SAFETY: test fixture; keys are opaque text in the kernel
  return value as RowKey;
};

const stamp = (ms: number, peer = PEER): Stamp => ({ hlc: hlcOf(ms, 0), peer });
const cell = (value: string, at: Stamp): Cell => ({ value, stamp: at });

const noteAt = (ms: number, values: Readonly<Record<string, string>>): RowRecord => ({
  cells: new Map(Object.entries(values).map(([name, v]) => [column(name), cell(v, stamp(ms))])),
  writeStamp: stamp(ms),
  partition: ACME,
});

const rows = (count: number): KeyedRecord[] =>
  Array.from({ length: count }, (_, i) => ({
    table: NOTES,
    key: key(`n${i}`),
    record: noteAt(1000 + i, { title: `title ${i}`, body: `body ${i}`, author: "someone" }),
  }));

const roundTrip = (input: readonly KeyedRecord[]) =>
  decodeSnapshotRows(encodeSnapshotRows(input)).unwrap();

describe("the snapshot codec", () => {
  test("what goes in comes out: cells, stamps, partition and all", () => {
    const input = rows(3);
    expect(roundTrip(input)).toEqual(input);
  });

  test("a cell moved by a later write keeps its own stamp; the rest share the row's", () => {
    const record: RowRecord = {
      cells: new Map([
        [column("title"), cell("revised", stamp(2000, OTHER))],
        [column("body"), cell("original", stamp(1000))],
      ]),
      writeStamp: stamp(1000),
      partition: ACME,
    };
    const [out] = roundTrip([{ table: NOTES, key: key("n1"), record }]);
    expect(out?.record.cells.get(column("title"))?.stamp).toEqual(stamp(2000, OTHER));
    expect(out?.record.cells.get(column("body"))?.stamp).toEqual(stamp(1000));
  });

  test("a tombstone travels with its delete stamp and no write of its own", () => {
    const record: RowRecord = { cells: new Map(), deleteStamp: stamp(3000), partition: ACME };
    expect(roundTrip([{ table: NOTES, key: key("n1"), record }])[0]?.record).toEqual(record);
  });

  test("the dictionaries pay for themselves: it beats a record at a time, and by a lot", () => {
    const input = rows(200);
    const compact = encodeSnapshotRows(input).length;
    const naive = input.reduce((n, { record }) => n + encodeRecord(record).length, 0);
    // one peer id and one set of column names for two hundred rows instead of per cell
    expect(compact * 3).toBeLessThan(naive);
  });

  test("an unreadable snapshot is a value, never a throw", () => {
    expect(decodeSnapshotRows(new Uint8Array([1, 2, 3])).isErr()).toBe(true);
    expect(decodeSnapshotRows(encodeSnapshotRows([]).slice(0, 2)).isErr()).toBe(true);
  });

  test("an index out of range is refused rather than read as some other row's column", () => {
    // one peer, one table with one column, and a row naming a column that is not there
    const stray = encodeCbor([
      1,
      [hexToBytes(PEER).unwrap()],
      [["notes", ["title"]]],
      [],
      [[0, "n1", [1000, 0, 0], null, null, [[7, "x"]]]],
    ]);
    const refused = decodeSnapshotRows(stray);
    expect(refused.isErr() && refused.error.message).toBe("column index is out of range");
  });

  test("a snapshot from a build this one does not know is refused, not half-read", () => {
    const refused = decodeSnapshotRows(encodeCbor([3, [], [], [], []]));
    expect(refused.isErr() && refused.error.message).toBe("snapshot version 3 is not 1 or 2");
    const short = decodeSnapshotRows(encodeCbor([2, [], [], [], []]));
    expect(short.isErr() && short.error.message).toBe("snapshot with documents is not a septuple");
  });
});

describe("a snapshot page carries the checkpoints of its rows' documents (RFC-0023 §5.5, E30 P5)", () => {
  const checkpoint = {
    producer: OTHER,
    checkpoint: Uint8Array.of(1, 2),
    snapshot: Uint8Array.of(3),
  };

  test("a page with documents round-trips, its producer after every peer its rows name", () => {
    const page = { rows: rows(2), docs: { checkpoints: [checkpoint], complete: true } };
    const bytes = encodeSnapshotPage(page);
    const back = decodeSnapshotPage(bytes).unwrap();
    expect(back).toEqual(page);
    expect(encodeSnapshotPage(back)).toEqual(bytes);
    // the rows read the same through the rows-only reader a sender built before P5 still has
    expect(decodeSnapshotRows(bytes).unwrap()).toEqual(page.rows);
  });

  test("a page without documents is version 1, byte for byte what it was", () => {
    const plain = encodeSnapshotPage({ rows: rows(2) });
    expect(plain).toEqual(encodeSnapshotRows(rows(2)));
    expect(decodeSnapshotPage(plain).unwrap().docs).toBeUndefined();
    const none = decodeSnapshotPage(
      encodeSnapshotPage({ rows: [], docs: { checkpoints: [], complete: false } }),
    ).unwrap();
    expect(none.docs).toEqual({ checkpoints: [], complete: false });
  });

  test("a malformed checkpoint entry is refused, not half-read", () => {
    const page = (entries: CborValue, complete: CborValue = true) =>
      decodeSnapshotPage(
        encodeCbor([2, [hexToBytes(PEER).unwrap()], [], [], [], entries, complete]),
      );
    const message = (entries: CborValue, complete?: CborValue) => {
      const refused = page(entries, complete);
      return refused.isErr() ? refused.error.message : "read";
    };
    expect(message([[0, Uint8Array.of(1), Uint8Array.of(2)]])).toBe("read");
    expect(message([[1, Uint8Array.of(1), Uint8Array.of(2)]])).toBe(
      "checkpoint producer index is out of range",
    );
    expect(message([[0, "x", Uint8Array.of(2)]])).toBe("checkpoint is not bytes");
    expect(message([[0, Uint8Array.of(1)]])).toBe("checkpoint is not a triple");
    expect(message("none")).toBe("checkpoints are not an array");
    expect(message([], 1)).toBe("completeness is not a boolean");
  });
});

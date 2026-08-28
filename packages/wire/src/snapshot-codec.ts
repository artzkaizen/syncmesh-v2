import type {
  Cell,
  ColumnName,
  KeyedRecord,
  PartitionKey,
  RowKey,
  Stamp,
  TableName,
} from "@syncmesh/kernel";

import { compareStamp, hlcOf, parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import type { CborValue } from "./cbor.js";

import { decodeCbor } from "./cbor-decode.js";
import { isSafeNonNegative, isString } from "./cbor-guards.js";
import { encodeCbor } from "./cbor.js";
import { bytesToHex, hexToBytes } from "./hex.js";
import { cellFromCbor, cellToCbor } from "./row-codec.js";

/**
 * A snapshot small enough to be worth sending (RFC-0019). Stored as-is, a `RowRecord` costs more
 * on the wire than the events it replaces: every cell carries its own stamp, and every stamp
 * repeats a 64-character peer id — around 540 bytes of provenance per 100 bytes of data.
 *
 * Three observations pay for themselves, and none of them lose anything:
 *
 * 1. **Peers repeat.** One dictionary; a stamp names an index.
 * 2. **Columns repeat.** One dictionary per table; a cell names an index.
 * 3. **Most cells share the row's write stamp.** A row written by one event has every cell at that
 *    stamp, so it is stored once on the row and only the exceptions carry their own.
 *
 * Partitions repeat for the same reason as peers and get the same treatment. The decoded records
 * are the ones that went in — the codec is an encoding, never a lossy summary.
 */

export class MalformedSnapshot extends TaggedError("MalformedSnapshot")<{ message: string }> {}

const malformed = (message: string) => Result.err(new MalformedSnapshot({ message }));

/** Assigns each distinct value an index the first time it is seen, in insertion order. */
const dictionary = <T>() => {
  const indexes = new Map<T, number>();
  const values: T[] = [];
  return {
    of: (value: T): number => {
      const held = indexes.get(value);
      if (held !== undefined) return held;
      indexes.set(value, values.length);
      values.push(value);
      return values.length - 1;
    },
    values,
  };
};

const VERSION = 1;

/**
 * `[version, peers, tables, partitions, rows]`, where a row is
 * `[tableIndex, key, writeStamp, deleteStamp, partitionIndex, cells]` and a cell is
 * `[columnIndex, value]` when it sits at the row's write stamp and `[columnIndex, value, stamp]`
 * when it does not.
 */
export function encodeSnapshotRows(rows: readonly KeyedRecord[]): Uint8Array {
  const peers = dictionary<string>();
  const partitions = dictionary<string>();
  const tables = dictionary<string>();
  const columns: ReturnType<typeof dictionary<string>>[] = [];

  const stampOut = (stamp: Stamp): CborValue => [
    stamp.hlc[0].epochMilliseconds,
    stamp.hlc[1],
    peers.of(stamp.peer),
  ];
  const encoded = rows.map(({ table, key, record }): CborValue => {
    const tableIndex = tables.of(table);
    const names = (columns[tableIndex] ??= dictionary<string>());
    const cells = [...record.cells].map(([column, cell]): CborValue =>
      // the row's write stamp covers the ordinary case: a row written by one event, whose cells
      // all sit at it. Only a cell some later write moved carries a stamp of its own.
      record.writeStamp !== undefined && compareStamp(cell.stamp, record.writeStamp) === 0
        ? [names.of(column), cellToCbor(cell.value)]
        : [names.of(column), cellToCbor(cell.value), stampOut(cell.stamp)],
    );
    return [
      tableIndex,
      key,
      record.writeStamp === undefined ? null : stampOut(record.writeStamp),
      record.deleteStamp === undefined ? null : stampOut(record.deleteStamp),
      record.partition === undefined ? null : partitions.of(record.partition),
      cells,
    ];
  });
  return encodeCbor([
    VERSION,
    peers.values.map((peer) => hexToBytes(peer).unwrap()),
    tables.values.map((table, i): CborValue => [table, columns[i]?.values ?? []]),
    partitions.values,
    encoded,
  ]);
}

/** The dictionaries a row is read against, resolved once rather than per cell. */
interface Dictionaries {
  readonly peers: readonly string[];
  readonly tables: readonly (readonly [TableName, readonly ColumnName[]])[];
  readonly partitions: readonly PartitionKey[];
}

export function decodeSnapshotRows(
  bytes: Uint8Array,
): Result<readonly KeyedRecord[], MalformedSnapshot> {
  return Result.gen(function* () {
    const value = yield* decodeCbor(bytes).mapError(
      (e) => new MalformedSnapshot({ message: e.message }),
    );
    if (!Array.isArray(value) || value.length !== 5)
      return malformed("snapshot is not a quintuple");
    const [version, peersValue, tablesValue, partitionsValue, rowsValue] = value;
    if (version !== VERSION)
      return malformed(`snapshot version ${String(version)} is not ${VERSION}`);
    const dictionaries = yield* readDictionaries(peersValue, tablesValue, partitionsValue);
    if (!Array.isArray(rowsValue)) return malformed("rows are not an array");
    const rows: KeyedRecord[] = [];
    for (const row of rowsValue) rows.push(yield* readRow(row, dictionaries));
    return Result.ok(rows);
  });
}

function readDictionaries(
  peersValue: CborValue | undefined,
  tablesValue: CborValue | undefined,
  partitionsValue: CborValue | undefined,
): Result<Dictionaries, MalformedSnapshot> {
  return Result.gen(function* () {
    if (!Array.isArray(peersValue)) return malformed("peers are not an array");
    const peers: string[] = [];
    for (const peer of peersValue) {
      if (!(peer instanceof Uint8Array)) return malformed("peer id is not bytes");
      peers.push(
        yield* parsePeerId(bytesToHex(peer)).mapError(
          (e) => new MalformedSnapshot({ message: e.message }),
        ),
      );
    }
    if (!Array.isArray(tablesValue)) return malformed("tables are not an array");
    const tables: (readonly [TableName, readonly ColumnName[]])[] = [];
    for (const entry of tablesValue) tables.push(yield* readTable(entry));
    if (!Array.isArray(partitionsValue)) return malformed("partitions are not an array");
    const partitions: PartitionKey[] = [];
    for (const partition of partitionsValue) {
      if (!isString(partition)) return malformed("partition is not text");
      partitions.push(
        yield* parsePartitionKey(partition).mapError(
          (e) => new MalformedSnapshot({ message: e.message }),
        ),
      );
    }
    return Result.ok({ peers, tables, partitions });
  });
}

function readTable(
  entry: CborValue,
): Result<readonly [TableName, readonly ColumnName[]], MalformedSnapshot> {
  if (!Array.isArray(entry) || entry.length !== 2) return malformed("table is not a pair");
  const [table, names] = entry;
  if (!isString(table)) return malformed("table name is not text");
  if (!Array.isArray(names)) return malformed("columns are not an array");
  const columns: ColumnName[] = [];
  for (const name of names) {
    if (!isString(name)) return malformed("column name is not text");
    // SAFETY: column naming rules are owned by the schema; the codec only requires text
    columns.push(name as ColumnName);
  }
  // SAFETY: table naming rules are owned by the schema; the codec only requires text
  return Result.ok([table as TableName, columns] as const);
}

function readRow(row: CborValue, dicts: Dictionaries): Result<KeyedRecord, MalformedSnapshot> {
  return Result.gen(function* () {
    if (!Array.isArray(row) || row.length !== 6) return malformed("row is not a sextuple");
    const [tableIndex, keyValue, writeValue, deleteValue, partitionIndex, cellsValue] = row;
    if (!isSafeNonNegative(tableIndex)) return malformed("table index is not an integer");
    const entry = dicts.tables[tableIndex];
    if (entry === undefined) return malformed("table index is out of range");
    if (!isString(keyValue)) return malformed("row key is not text");
    const writeStamp = yield* optionalStamp(writeValue, dicts.peers);
    const deleteStamp = yield* optionalStamp(deleteValue, dicts.peers);
    if (!Array.isArray(cellsValue)) return malformed("cells are not an array");
    const cells = new Map<ColumnName, Cell>();
    for (const cell of cellsValue) {
      const [column, decoded] = yield* readCell(cell, entry[1], dicts.peers, writeStamp);
      cells.set(column, decoded);
    }
    const partition = yield* readPartition(partitionIndex, dicts.partitions);
    // SAFETY: keys are opaque text in the kernel; what may be a key is the schema's rule
    const key = keyValue as RowKey;
    return Result.ok({
      table: entry[0],
      key,
      record: assemble(cells, writeStamp, deleteStamp, partition),
    });
  });
}

const readPartition = (
  index: CborValue | undefined,
  partitions: readonly PartitionKey[],
): Result<PartitionKey | undefined, MalformedSnapshot> => {
  if (index === null) return Result.ok(undefined);
  if (!isSafeNonNegative(index)) return malformed("partition index is not an integer");
  const partition = partitions[index];
  return partition === undefined
    ? malformed("partition index is out of range")
    : Result.ok(partition);
};

/** Only the fields the row actually had, so an encode of a decode is the same bytes again. */
function assemble(
  cells: ReadonlyMap<ColumnName, Cell>,
  writeStamp: Stamp | undefined,
  deleteStamp: Stamp | undefined,
  partition: PartitionKey | undefined,
) {
  const base = { cells };
  const written = writeStamp === undefined ? base : { ...base, writeStamp };
  const deleted = deleteStamp === undefined ? written : { ...written, deleteStamp };
  return partition === undefined ? deleted : { ...deleted, partition };
}

function readCell(
  value: CborValue,
  columns: readonly ColumnName[],
  peers: readonly string[],
  writeStamp: Stamp | undefined,
): Result<readonly [ColumnName, Cell], MalformedSnapshot> {
  return Result.gen(function* () {
    if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3))
      return malformed("cell is not a pair or a triple");
    const [columnIndex, cellValue, stampValue] = value;
    if (!isSafeNonNegative(columnIndex)) return malformed("column index is not an integer");
    const column = columns[columnIndex];
    if (column === undefined) return malformed("column index is out of range");
    const decoded = yield* cellFromCbor(cellValue).mapError(
      (e) => new MalformedSnapshot({ message: e.message }),
    );
    // a cell with no stamp of its own sits at the row's write stamp — the whole point of the dedup
    if (stampValue === undefined) {
      if (writeStamp === undefined) return malformed("a cell has no stamp and neither has its row");
      return Result.ok([column, { value: decoded, stamp: writeStamp }] as const);
    }
    const stamp = yield* readStamp(stampValue, peers);
    return Result.ok([column, { value: decoded, stamp }] as const);
  });
}

const optionalStamp = (
  value: CborValue | undefined,
  peers: readonly string[],
): Result<Stamp | undefined, MalformedSnapshot> =>
  value === null ? Result.ok(undefined) : readStamp(value, peers);

function readStamp(
  value: CborValue | undefined,
  peers: readonly string[],
): Result<Stamp, MalformedSnapshot> {
  if (!Array.isArray(value) || value.length !== 3) return malformed("stamp is not a triple");
  const [ms, logical, peerIndex] = value;
  if (!isSafeNonNegative(ms) || !isSafeNonNegative(logical))
    return malformed("stamp clock is not a pair of integers");
  if (!isSafeNonNegative(peerIndex)) return malformed("stamp peer is not an index");
  const peer = peers[peerIndex];
  if (peer === undefined) return malformed("stamp peer index is out of range");
  return parsePeerId(peer)
    .mapError((e) => new MalformedSnapshot({ message: e.message }))
    .map((parsed) => ({ hlc: hlcOf(ms, logical), peer: parsed }));
}

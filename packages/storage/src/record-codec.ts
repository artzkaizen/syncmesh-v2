import type { Cell, ColumnName, RowRecord, Stamp } from "@syncmesh/kernel";
import type { CborValue } from "@syncmesh/wire";

import { parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import {
  bytesToHex,
  cellFromCbor,
  cellToCbor,
  decodeCbor,
  encodeCbor,
  hexToBytes,
  isSafeNonNegative,
  isString,
} from "@syncmesh/wire";

import { hlcOf } from "./sql.js";

export class MalformedRecord extends TaggedError("MalformedRecord")<{ message: string }> {}

const malformed = (message: string) => Result.err(new MalformedRecord({ message }));

const stampToCbor = (stamp: Stamp): CborValue => [
  stamp.hlc[0].epochMilliseconds,
  stamp.hlc[1],
  hexToBytes(stamp.peer).unwrap(),
];

const optional = (stamp: Stamp | undefined): CborValue =>
  stamp === undefined ? null : stampToCbor(stamp);

/** `[cells[[column, value, stamp]], writeStamp | null, deleteStamp | null, partition | null]`, stamps as `[ms, logical, peer]`. */
export function encodeRecord(record: RowRecord): Uint8Array {
  const cells = [...record.cells].map(([column, cell]): CborValue => [
    column,
    cellToCbor(cell.value),
    stampToCbor(cell.stamp),
  ]);
  return encodeCbor([
    cells,
    optional(record.writeStamp),
    optional(record.deleteStamp),
    record.partition ?? null,
  ]);
}

export function decodeRecord(bytes: Uint8Array): Result<RowRecord, MalformedRecord> {
  return Result.gen(function* () {
    const value = yield* decodeCbor(bytes).mapError(
      (e) => new MalformedRecord({ message: e.message }),
    );
    if (!Array.isArray(value) || value.length !== 4) return malformed("record is not a quadruple");
    const [cellsValue, writeValue, deleteValue, partitionValue] = value;
    if (!Array.isArray(cellsValue)) return malformed("cells are not an array");
    const cells = new Map<ColumnName, Cell>();
    for (const entry of cellsValue) {
      const [column, cell] = yield* decodeCell(entry);
      cells.set(column, cell);
    }
    const writeStamp = yield* optionalStamp(writeValue);
    const deleteStamp = yield* optionalStamp(deleteValue);
    const stamped = withStamps(cells, writeStamp, deleteStamp);
    if (partitionValue === null) return Result.ok(stamped);
    if (!isString(partitionValue)) return malformed("partition is not text");
    const partition = yield* parsePartitionKey(partitionValue).mapError(
      (e) => new MalformedRecord({ message: e.message }),
    );
    return Result.ok({ ...stamped, partition });
  });
}

function withStamps(
  cells: ReadonlyMap<ColumnName, Cell>,
  writeStamp: Stamp | undefined,
  deleteStamp: Stamp | undefined,
): RowRecord {
  if (writeStamp !== undefined && deleteStamp !== undefined)
    return { cells, writeStamp, deleteStamp };
  if (writeStamp !== undefined) return { cells, writeStamp };
  if (deleteStamp !== undefined) return { cells, deleteStamp };
  return { cells };
}

function decodeCell(value: CborValue): Result<readonly [ColumnName, Cell], MalformedRecord> {
  if (!Array.isArray(value) || value.length !== 3) return malformed("cell is not a triple");
  const [column, cellValue, stampValue] = value;
  if (!isString(column)) return malformed("column name is not text");
  return Result.gen(function* () {
    const decoded = yield* cellFromCbor(cellValue).mapError(
      (e) => new MalformedRecord({ message: e.message }),
    );
    const stamp = yield* stampFromCbor(stampValue);
    // SAFETY: column naming rules are owned by the schema (E05); the cache only requires text
    return Result.ok([column as ColumnName, { value: decoded, stamp }] as const);
  });
}

const optionalStamp = (value: CborValue | undefined): Result<Stamp | undefined, MalformedRecord> =>
  value === null ? Result.ok(undefined) : stampFromCbor(value);

function stampFromCbor(value: CborValue | undefined): Result<Stamp, MalformedRecord> {
  if (!Array.isArray(value) || value.length !== 3) return malformed("stamp is not a triple");
  const [ms, logical, peer] = value;
  if (!isSafeNonNegative(ms) || !isSafeNonNegative(logical))
    return malformed("stamp clock is not a pair of integers");
  if (!(peer instanceof Uint8Array)) return malformed("stamp peer is not bytes");
  return parsePeerId(bytesToHex(peer))
    .mapError((e) => new MalformedRecord({ message: e.message }))
    .map((peerId) => ({ hlc: hlcOf(ms, logical), peer: peerId }));
}

import type { Cell, ColumnName, PeerId, RowRecord, Stamp } from "@syncmesh/kernel";

import { hlcOf, parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import type { CborValue } from "./cbor.js";

import { decodeCbor } from "./cbor-decode.js";
import { isSafeNonNegative, isString } from "./cbor-guards.js";
import { encodeCbor } from "./cbor.js";
import { bytesToHex, hexToBytes } from "./hex.js";
import { cellFromCbor, cellToCbor } from "./row-codec.js";

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
    // SAFETY: column naming rules are owned by the schema; the cache only requires text
    return Result.ok([column as ColumnName, { value: decoded, stamp }] as const);
  });
}

const optionalStamp = (value: CborValue | undefined): Result<Stamp | undefined, MalformedRecord> =>
  value === null ? Result.ok(undefined) : stampFromCbor(value);

/**
 * The devices this process has already decoded a stamp for, keyed by their raw bytes.
 *
 * The population is a mesh's device set — a handful, and the same handful for the life of the
 * process — while the *lookups* are one per cell, which is thousands per boot. The key is the
 * bytes read as latin-1 rather than as hex because it is only ever compared, never shown: one
 * string of 32 characters against `bytesToHex`'s loop of 32 `toString`/`padStart`/concat triples,
 * which is the work this exists to stop repeating.
 */
const peers = new Map<string, PeerId>();

const keyOf = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

/** The peer id for these bytes, validated the first time and remembered after. */
function internPeer(bytes: Uint8Array): Result<PeerId, MalformedRecord> {
  const key = keyOf(bytes);
  const known = peers.get(key);
  if (known !== undefined) return Result.ok(known);
  return parsePeerId(bytesToHex(bytes))
    .mapError((e) => new MalformedRecord({ message: e.message }))
    .map((peerId) => {
      peers.set(key, peerId);
      return peerId;
    });
}

function stampFromCbor(value: CborValue | undefined): Result<Stamp, MalformedRecord> {
  if (!Array.isArray(value) || value.length !== 3) return malformed("stamp is not a triple");
  const [ms, logical, peer] = value;
  if (!isSafeNonNegative(ms) || !isSafeNonNegative(logical))
    return malformed("stamp clock is not a pair of integers");
  if (!(peer instanceof Uint8Array)) return malformed("stamp peer is not bytes");
  return internPeer(peer).map((peerId) => ({ hlc: hlcOf(ms, logical), peer: peerId }));
}

import type {
  CellValue,
  Change,
  ColumnName,
  Hlc,
  JsonValue,
  Logical,
  Row,
  RowKey,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";

import {
  eventId,
  parsePeerId,
  parseSeqNum,
  type PartitionKey,
  type Procedure,
} from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import { decodeCbor, type MalformedCbor } from "./cbor-decode.js";
import { encodeCbor, type CborKey, type CborValue } from "./cbor.js";
import { bytesToHex, hexToBytes } from "./hex.js";

export class MalformedEvent extends TaggedError("MalformedEvent")<{ message: string }> {}

/** Event core map keys, frozen by the vectors (RFC-0002). */
const KEY = { v: 0, peerId: 1, seq: 2, hlc: 3, procedure: 5, partition: 6, changes: 7 } as const;
const CHANGE = { kind: 0, table: 1, key: 2, data: 3 } as const;
const KIND = { insert: 0, update: 1, delete: 2 } as const;

export function encodeEventCore(event: SyncEvent): Uint8Array {
  const core = new Map<CborKey, CborValue>([
    [KEY.v, event.v],
    [KEY.peerId, hexToBytes(event.peerId).unwrap()],
    [KEY.seq, event.seqNum],
    [KEY.hlc, [event.hlc[0].epochMilliseconds, event.hlc[1]]],
    [KEY.procedure, event.procedure],
    [KEY.changes, event.changes.map(encodeChange)],
  ]);
  if (event.partition !== undefined) core.set(KEY.partition, event.partition);
  return encodeCbor(core);
}

const encodeChange = (change: Change): CborValue =>
  new Map<CborKey, CborValue>([
    [CHANGE.kind, KIND[change.kind]],
    [CHANGE.table, change.table],
    [CHANGE.key, change.key],
    [
      CHANGE.data,
      change.kind === "delete"
        ? null
        : rowToCbor(change.kind === "insert" ? change.row : change.patch),
    ],
  ]);

const rowToCbor = (row: Row): CborValue =>
  new Map<CborKey, CborValue>([...row].map(([c, v]) => [c, cellToCbor(v)]));

/* oxlint-disable anti-slop/no-runtime-typeof -- a serializer dispatches on the runtime type of what it encodes */
const cellToCbor = (v: CellValue): CborValue => {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(cellToCbor);
  return new Map<CborKey, CborValue>(Object.entries(v).map(([k, x]) => [k, cellToCbor(x)]));
};
/* oxlint-enable anti-slop/no-runtime-typeof */

const malformed = (message: string) => Result.err(new MalformedEvent({ message }));

/** Decodes a core; refuses `v ≠ 1`; ignores unknown keys. Never throws. */
export function decodeEventCore(
  core: Uint8Array,
): Result<SyncEvent, MalformedEvent | MalformedCbor> {
  return decodeCbor(core).andThen(decodeEventValue);
}

function decodeEventValue(value: CborValue): Result<SyncEvent, MalformedEvent> {
  if (!(value instanceof Map)) return malformed("core is not a map");
  const m = value;
  if (m.get(KEY.v) !== 1) return malformed("unsupported version");
  const peerBytes = m.get(KEY.peerId);
  if (!(peerBytes instanceof Uint8Array)) return malformed("peerId is not bytes");
  const seq = m.get(KEY.seq);
  const hlc = m.get(KEY.hlc);
  const procedure = m.get(KEY.procedure);
  const partition = m.get(KEY.partition);
  const changes = m.get(KEY.changes);
  if (!Array.isArray(hlc) || hlc.length !== 2) return malformed("hlc is not a pair");
  if (!isString(procedure)) return malformed("procedure is not text");
  if (partition !== undefined && !isString(partition)) return malformed("partition is not text");
  if (!Array.isArray(changes)) return malformed("changes is not an array");
  const [ms, logical] = hlc;
  if (!isSafeNonNegative(ms) || !isSafeNonNegative(logical))
    return malformed("hlc components are not integers");
  if (!isSafeNonNegative(seq)) return malformed("seq is not an integer");
  return Result.gen(function* () {
    const peerId = yield* parsePeerId(bytesToHex(peerBytes)).mapError(
      (e) => new MalformedEvent({ message: e.message }),
    );
    const seqNum = yield* parseSeqNum(seq).mapError(
      (e) => new MalformedEvent({ message: e.message }),
    );
    const decoded: Change[] = [];
    for (const c of changes) decoded.push(yield* decodeChange(c));
    const base = {
      v: 1 as const,
      id: eventId(peerId, seqNum),
      peerId,
      seqNum,
      hlc: [Temporal.Instant.fromEpochMilliseconds(ms), asLogical(logical)] satisfies Hlc,
      procedure: asProcedure(procedure),
      changes: decoded,
    };
    return Result.ok(
      partition === undefined ? base : { ...base, partition: asPartition(partition) },
    );
  });
}

function decodeChange(value: CborValue): Result<Change, MalformedEvent> {
  if (!(value instanceof Map)) return malformed("change is not a map");
  const kind = value.get(CHANGE.kind);
  const table = value.get(CHANGE.table);
  const key = value.get(CHANGE.key);
  const data = value.get(CHANGE.data);
  if (!isString(table) || !isString(key)) return malformed("change table/key are not text");
  const t = asTable(table);
  const k = asKey(key);
  if (kind === KIND.delete) return Result.ok({ kind: "delete", table: t, key: k });
  if (kind !== KIND.insert && kind !== KIND.update) return malformed("unknown change kind");
  return decodeRow(data).map((row) =>
    kind === KIND.insert
      ? { kind: "insert", table: t, key: k, row }
      : { kind: "update", table: t, key: k, patch: row },
  );
}

function decodeRow(value: CborValue | undefined): Result<Row, MalformedEvent> {
  if (!(value instanceof Map)) return malformed("change data is not a map");
  const row = new Map<ColumnName, CellValue>();
  for (const [column, cell] of value) {
    if (!isString(column)) return malformed("column name is not text");
    const decoded = cellFromCbor(cell);
    if (decoded.isErr()) return decoded;
    row.set(asColumn(column), decoded.value);
  }
  return Result.ok(row);
}

function cellFromCbor(value: CborValue): Result<CellValue, MalformedEvent> {
  if (value === null || isString(value) || isBoolean(value) || isNumber(value))
    return Result.ok(value);
  if (value instanceof Uint8Array) return Result.ok(value);
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const decoded = jsonFromCbor(item);
      if (decoded.isErr()) return decoded;
      items.push(decoded.value);
    }
    return Result.ok(items);
  }
  if (!(value instanceof Map)) return malformed("unsupported cell shape");
  const object: Record<string, JsonValue> = {};
  for (const [k, v] of value) {
    if (!isString(k)) return malformed("json object keys must be text");
    const decoded = jsonFromCbor(v);
    if (decoded.isErr()) return decoded;
    object[k] = decoded.value;
  }
  return Result.ok(object);
}

function jsonFromCbor(value: CborValue): Result<JsonValue, MalformedEvent> {
  if (value instanceof Uint8Array) return malformed("bytes are only allowed at the top of a cell");
  // SAFETY: bytes were excluded above and nested bytes are refused recursively, so what remains is JSON
  return cellFromCbor(value).map((v) => v as JsonValue);
}

/* oxlint-disable anti-slop/no-runtime-typeof -- decoding is the I/O boundary; these are the parsers */
const isString = (v: CborValue | undefined): v is string => typeof v === "string";
const isSafeNonNegative = (v: CborValue | undefined): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isBoolean = (v: CborValue | undefined): v is boolean => typeof v === "boolean";
const isNumber = (v: CborValue | undefined): v is number => typeof v === "number";
/* oxlint-enable anti-slop/no-runtime-typeof */

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- each brand below is applied right after the check that establishes it; naming rules for these identifiers are owned by later epics (E05, E08, E09) */
const asLogical = (n: number) => n as Logical;
const asProcedure = (s: string) => s as Procedure;
const asPartition = (s: string) => s as PartitionKey;
const asTable = (s: string) => s as TableName;
const asKey = (s: string) => s as RowKey;
const asColumn = (s: string) => s as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

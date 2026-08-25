import type { Change, Hlc, Logical, RowKey, SyncEvent, TableName } from "@syncmesh/kernel";

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
import { isSafeNonNegative, isString } from "./cbor-guards.js";
import { encodeCbor, type CborKey, type CborValue } from "./cbor.js";
import { bytesToHex, hexToBytes } from "./hex.js";
import { rowFromCbor, rowToCbor } from "./row-codec.js";

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
  return rowFromCbor(data)
    .mapError((e) => new MalformedEvent({ message: e.message }))
    .map((row) =>
      kind === KIND.insert
        ? { kind: "insert", table: t, key: k, row }
        : { kind: "update", table: t, key: k, patch: row },
    );
}

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- each brand below is applied right after the check that establishes it; naming rules for these identifiers are owned by later epics (E05, E08, E09) */
const asLogical = (n: number) => n as Logical;
const asProcedure = (s: string) => s as Procedure;
const asPartition = (s: string) => s as PartitionKey;
const asTable = (s: string) => s as TableName;
const asKey = (s: string) => s as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

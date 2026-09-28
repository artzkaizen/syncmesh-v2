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

import type { EventCrypto } from "./sealing.js";

import { decodeCbor, type MalformedCbor } from "./cbor-decode.js";
import { isSafeNonNegative, isString } from "./cbor-guards.js";
import { encodeCbor, type CborKey, type CborValue } from "./cbor.js";
import { actionIdOf, docDataToCbor, docFromCbor } from "./doc-codec.js";
import { bytesToHex, hexToBytes } from "./hex.js";
import { rowFromCbor, rowToCbor } from "./row-codec.js";

export class MalformedEvent extends TaggedError("MalformedEvent")<{ message: string }> {}

/**
 * Event core map keys, frozen by the vectors (RFC-0002). 4 was never used and stays retired;
 * 9 is `schemaVersion` on the branch that claims it. `action` and `undoOf` (RFC-0023 §5.2)
 * drive history and undo only: a build that skips them folds the event identically, which is
 * why neither needs a `v` bump.
 */
const KEY = {
  v: 0,
  peerId: 1,
  seq: 2,
  hlc: 3,
  procedure: 5,
  partition: 6,
  changes: 7,
  /**
   * The sealed form of `changes`, for a partition declared `sealed` (book ch. 14). Exactly one
   * of the two is ever present: an event whose content is sealed carries no plaintext changes to
   * be inconsistent with, and a build with no name for this key reads the event as one with
   * nothing in it, which is what a carrier does anyway.
   */
  sealed: 8,
  action: 10,
  undoOf: 11,
} as const;

/**
 * What a sealed payload is bound to: the parts of the envelope that stay in the clear.
 *
 * Author, sequence and partition, and nothing else — a payload that authenticates its own place
 * cannot be lifted out of one event and into another, whatever else is re-encoded around it.
 */
const sealingAad = (event: Pick<SyncEvent, "peerId" | "seqNum" | "partition">): Uint8Array =>
  encodeCbor([hexToBytes(event.peerId).unwrap(), event.seqNum, event.partition ?? ""]);

/** One change's map keys, shared with the cell-change codec so both write the same envelope. */
export const CHANGE = { kind: 0, table: 1, key: 2, data: 3 } as const;

/**
 * The change kinds an encoder here emits. 3, 4 and 5 were the cell lattices D25 deleted and are
 * **never reused** — an old log may still hold them, and they decode as `unknown`. 6 is a document
 * update (RFC-0023 §5.1).
 *
 * A tag this build does not know is decoded as an `unknown` change carrying its payload untouched
 * (D22-A), never folded as an ordinary value — which would silently mangle the column — and never
 * refused, which used to make the event a wire error both transports dropped before `admit` could
 * park it. Parked, it holds the author's cursor open at its own sequence, which is the only place
 * a later build can pick the run back up from.
 */
const KIND = { insert: 0, update: 1, delete: 2, doc: 6 } as const;

export function encodeEventCore(event: SyncEvent, crypto?: EventCrypto): Uint8Array {
  const core = new Map<CborKey, CborValue>([
    [KEY.v, event.v],
    [KEY.peerId, hexToBytes(event.peerId).unwrap()],
    [KEY.seq, event.seqNum],
    [KEY.hlc, [event.hlc[0].epochMilliseconds, event.hlc[1]]],
    [KEY.procedure, event.procedure],
  ]);
  if (event.partition !== undefined) core.set(KEY.partition, event.partition);
  if (event.action !== undefined) core.set(KEY.action, hexToBytes(event.action).unwrap());
  if (event.undoOf !== undefined) core.set(KEY.undoOf, hexToBytes(event.undoOf).unwrap());
  const changes = event.changes.map(encodeChange);
  const sealed =
    event.partition === undefined
      ? undefined
      : crypto?.seal?.(event.partition, encodeCbor(changes), sealingAad(event));
  // exactly one of the two: a sealed event has no plaintext to be inconsistent with
  core.set(sealed === undefined ? KEY.changes : KEY.sealed, sealed ?? changes);
  return encodeCbor(core);
}

const encodeChange = (change: Change): CborValue =>
  new Map<CborKey, CborValue>([
    [CHANGE.kind, change.kind === "unknown" ? change.tag : KIND[change.kind]],
    [CHANGE.table, change.table],
    [CHANGE.key, change.key],
    [CHANGE.data, dataToCbor(change)],
  ]);

/**
 * An `unknown` change goes back out as the value it came in as (D22-A). It came from
 * `decodeCbor`, and canonical encoding is a function of the value, so the round trip is
 * byte-identical — which is what lets a device that parked one still serve the run it sits in.
 */
const dataToCbor = (change: Change): CborValue => {
  if (change.kind === "delete") return null;
  if (change.kind === "insert") return rowToCbor(change.row);
  if (change.kind === "update") return rowToCbor(change.patch);
  if (change.kind === "doc") return docDataToCbor(change);
  // SAFETY: an `unknown` change is only ever built by `decodeChange` below, from a value CBOR read
  return change.data as CborValue;
};

const malformed = (message: string) => Result.err(new MalformedEvent({ message }));

/** Decodes a core; refuses `v ≠ 1`; ignores unknown keys. Never throws. */
export function decodeEventCore(
  core: Uint8Array,
  crypto?: EventCrypto,
): Result<SyncEvent, MalformedEvent | MalformedCbor> {
  return decodeCbor(core).andThen((value) => decodeEventValue(value, crypto));
}

function decodeEventValue(
  value: CborValue,
  crypto?: EventCrypto,
): Result<SyncEvent, MalformedEvent> {
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
  const action = actionIdOf(m.get(KEY.action));
  const undoOf = actionIdOf(m.get(KEY.undoOf));
  const under = m.get(KEY.sealed);
  if (partition !== undefined && !isString(partition)) return malformed("partition is not text");
  if (!Array.isArray(hlc) || hlc.length !== 2) return malformed("hlc is not a pair");
  if (!isString(procedure)) return malformed("procedure is not text");
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
    const place = {
      peerId,
      seqNum,
      ...(partition !== undefined && { partition: asPartition(partition) }),
    };
    const changes = yield* readChanges(m, under, place, crypto);
    const base = {
      v: 1 as const,
      id: eventId(peerId, seqNum),
      peerId,
      seqNum,
      hlc: [Temporal.Instant.fromEpochMilliseconds(ms), asLogical(logical)] satisfies Hlc,
      procedure: asProcedure(procedure),
      changes: changes.changes,
      ...(changes.sealed === true && { sealed: true as const }),
      ...(partition !== undefined && { partition: asPartition(partition) }),
      ...(action !== undefined && { action }),
      ...(undoOf !== undefined && { undoOf }),
    };
    return Result.ok(base);
  });
}

/**
 * The changes this device can read: the plaintext list, the list behind a seal it holds the key
 * for, or nothing at all — which is what a carrier gets and is not an error.
 */
function readChanges(
  m: ReadonlyMap<CborKey, CborValue>,
  under: CborValue | undefined,
  place: Pick<SyncEvent, "peerId" | "seqNum" | "partition">,
  crypto: EventCrypto | undefined,
): Result<{ readonly changes: Change[]; readonly sealed?: true }, MalformedEvent> {
  if (under !== undefined) {
    if (!(under instanceof Uint8Array)) return malformed("a sealed payload is not bytes");
    const opened =
      place.partition === undefined
        ? undefined
        : crypto?.open?.(place.partition, under, sealingAad(place));
    // no key: the event is carried whole and folds to nothing, which is custody without judgment
    if (opened === undefined) return Result.ok({ changes: [], sealed: true });
    return decodeCbor(opened)
      .mapError((e) => new MalformedEvent({ message: e.message }))
      .andThen(decodeChangeList);
  }
  const changes = m.get(KEY.changes);
  if (!Array.isArray(changes)) return malformed("changes is not an array");
  return decodeChangeList(changes);
}

function decodeChangeList(
  value: CborValue,
): Result<{ readonly changes: Change[] }, MalformedEvent> {
  if (!Array.isArray(value)) return malformed("changes is not an array");
  return Result.gen(function* () {
    const decoded: Change[] = [];
    for (const c of value) decoded.push(yield* decodeChange(c));
    return Result.ok({ changes: decoded });
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
  if (kind === KIND.doc)
    return docFromCbor(t, k, data).mapError((e) => new MalformedEvent({ message: e.message }));
  // a tag this build does not know is kept whole rather than refused (D22-A). Refusing made the
  // event a wire error that both transports dropped before `admit` ran, so the quarantine D13
  // asks for could never see it — and a newer peer's write vanished with no trace anywhere
  if (kind !== KIND.insert && kind !== KIND.update) {
    if (!isSafeNonNegative(kind)) return malformed("change kind is not a tag");
    return Result.ok({ kind: "unknown", tag: kind, table: t, key: k, data });
  }
  return rowFromCbor(data)
    .mapError((e) => new MalformedEvent({ message: e.message }))
    .map((row) =>
      kind === KIND.insert
        ? { kind: "insert", table: t, key: k, row }
        : { kind: "update", table: t, key: k, patch: row },
    );
}

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- each brand below is applied right after the check that establishes it; naming rules for these identifiers are owned by the schema */
const asLogical = (n: number) => n as Logical;
const asProcedure = (s: string) => s as Procedure;
const asPartition = (s: string) => s as PartitionKey;
const asTable = (s: string) => s as TableName;
const asKey = (s: string) => s as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

import type {
  ColumnName,
  DocBlobRef,
  DocChange,
  DocUpdate,
  LineageId,
  PeerId,
  RowKey,
  SeqNum,
  TableName,
} from "@syncmesh/kernel";

import { sha256 } from "@noble/hashes/sha2.js";
import { parseActionId, parseAdapterId, parseLineageId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import type { CborKey, CborValue } from "./cbor.js";

import { isSafeNonNegative, isString } from "./cbor-guards.js";
import { bytesToHex, hexToBytes } from "./hex.js";

/**
 * The `data` map of a `doc` change (tag 6), frozen by `conformance/doc-vectors.json` (RFC-0023
 * §5.1). Exactly one of `bytes` and `blob` is present; unknown keys are skipped (RFC-0002
 * invariant 4) and are never re-emitted — the log keeps the author's core bytes for that.
 */
export const DOC = { column: 0, adapter: 1, lineage: 2, bytes: 3, blob: 4, genesis: 5 } as const;

/** Both 16-byte ids — lineage, action — are this long on the wire. */
export const ID16_LENGTH = 16;

export const SHA256_LENGTH = 32;

export class MalformedDoc extends TaggedError("MalformedDoc")<{ message: string }> {}

const malformed = (message: string) => Result.err(new MalformedDoc({ message }));

const u64be = (n: number): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
};

const u32be = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
};

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const LINEAGE_DOMAIN = new TextEncoder().encode("syncmesh/doc-lineage");

/**
 * One doc change, named: the author's key (32 bytes), the event's sequence as a big-endian u64,
 * and the change's index in the event as a big-endian u32 — 44 bytes, fixed width, so another
 * runtime reproduces it with no CBOR at all. What a doc digest sums the hashes of, and what a
 * lineage is derived from.
 */
export const docChangeId = (peerId: PeerId, seq: SeqNum, index: number): Uint8Array =>
  concat(hexToBytes(peerId).unwrap(), u64be(seq), u32be(index));

/**
 * The lineage a genesis must name: `sha256("syncmesh/doc-lineage" ‖ docChangeId)[..16]` (RFC-0023
 * §5.3). Deterministic, so a receiver recomputes it and refuses a genesis that names another —
 * which is what stops one history being passed off as the start of a different one.
 */
export function deriveLineage(peerId: PeerId, seq: SeqNum, index: number): LineageId {
  const hash = sha256(concat(LINEAGE_DOMAIN, docChangeId(peerId, seq, index)));
  return parseLineageId(bytesToHex(hash.subarray(0, ID16_LENGTH))).unwrap();
}

export const blobToCbor = (blob: DocBlobRef): CborValue => [
  hexToBytes(blob.hash).unwrap(),
  blob.size,
];

export const blobFromCbor = (value: CborValue | undefined): Result<DocBlobRef, MalformedDoc> => {
  if (!Array.isArray(value) || value.length !== 2) return malformed("blob is not [hash, size]");
  const [hash, size] = value;
  if (!(hash instanceof Uint8Array) || hash.length !== SHA256_LENGTH)
    return malformed("blob hash is not 32 bytes");
  if (!isSafeNonNegative(size)) return malformed("blob size is not an integer");
  return Result.ok({ hash: bytesToHex(hash), size });
};

/** A 16-byte id as hex, or `undefined` for anything else — lenient where the reader must be. */
export const id16 = (value: CborValue | undefined): string | undefined =>
  value instanceof Uint8Array && value.length === ID16_LENGTH ? bytesToHex(value) : undefined;

/** A doc change's `data` map. */
export function docDataToCbor(change: DocChange): CborValue {
  const data = new Map<CborKey, CborValue>([
    [DOC.column, change.column],
    [DOC.adapter, change.adapter],
  ]);
  if (change.lineage !== undefined) data.set(DOC.lineage, hexToBytes(change.lineage).unwrap());
  if (change.update.bytes !== undefined) data.set(DOC.bytes, change.update.bytes);
  else data.set(DOC.blob, blobToCbor(change.update.blob));
  if (change.genesis === true) data.set(DOC.genesis, true);
  return data;
}

/**
 * A doc change from its `data` map. Refuses what no fold could take — no column, no adapter, a
 * lineage that is not 16 bytes, both or neither of `bytes` and `blob`, a `genesis` that is not
 * `true` — and skips keys it has no name for. Never throws.
 */
export function docFromCbor(
  table: TableName,
  key: RowKey,
  value: CborValue | undefined,
): Result<DocChange, MalformedDoc> {
  if (!(value instanceof Map)) return malformed("doc data is not a map");
  const column = value.get(DOC.column);
  const adapter = value.get(DOC.adapter);
  const lineage = value.get(DOC.lineage);
  const bytes = value.get(DOC.bytes);
  const blob = value.get(DOC.blob);
  const genesis = value.get(DOC.genesis);
  if (!isString(column) || column.length === 0) return malformed("doc column is not text");
  if (!isString(adapter)) return malformed("doc adapter is not text");
  const adapterId = parseAdapterId(adapter);
  if (adapterId.isErr()) return malformed(`doc adapter: ${adapterId.error.message}`);
  if ((bytes === undefined) === (blob === undefined))
    return malformed("a doc change carries exactly one of bytes and blob");
  if (bytes !== undefined && !(bytes instanceof Uint8Array))
    return malformed("doc bytes are not bytes");
  if (genesis !== undefined && genesis !== true) return malformed("genesis is only ever true");
  const lineageId = lineage === undefined ? undefined : id16(lineage);
  if (lineage !== undefined && lineageId === undefined)
    return malformed("doc lineage is not 16 bytes");
  const update: Result<DocUpdate, MalformedDoc> =
    bytes instanceof Uint8Array
      ? Result.ok({ bytes })
      : blobFromCbor(blob).map((ref) => ({ blob: ref }));
  return update.map((carried) => ({
    kind: "doc" as const,
    table,
    key,
    column: asColumn(column),
    adapter: adapterId.value,
    update: carried,
    ...(lineageId !== undefined && { lineage: parseLineageId(lineageId).unwrap() }),
    ...(genesis === true && { genesis: true as const }),
  }));
}

// SAFETY: column naming rules are owned by the schema; the codec only requires non-empty text
const asColumn = (s: string) => s as ColumnName;

/**
 * An action id from event key 10 or 11, or `undefined` for a value that is not 16 bytes. Lenient
 * on purpose: an old build skips both keys and folds the event, so a new one that refused the
 * event over them would park what every old peer folded — the divergence D13 exists to prevent.
 */
export const actionIdOf = (value: CborValue | undefined) => {
  const hex = id16(value);
  return hex === undefined ? undefined : parseActionId(hex).unwrapOr(undefined);
};

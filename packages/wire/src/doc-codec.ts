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
import {
  GENESIS_RULE,
  LOGICAL_MAX,
  SETTLED_RULE,
  hlcOf,
  parseActionId,
  parseAdapterId,
  parseLineageId,
  parsePeerId,
  type SettledLineage,
} from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import type { CborKey, CborValue } from "./cbor.js";

import { isSafeNonNegative, isString } from "./cbor-guards.js";
import { bytesToHex, hexToBytes } from "./hex.js";

/**
 * The `data` map of a `doc` change (tag 6), frozen by `conformance/doc-vectors.json` (RFC-0023
 * §5.1). Exactly one of `bytes` and `blob` is present; unknown keys are skipped (RFC-0002
 * invariant 4) and are never re-emitted — the log keeps the author's core bytes for that. Key 7,
 * `settles`, rides only on a genesis whose key 5 is {@link SETTLED_RULE} (gaps U21).
 */
export const DOC = {
  column: 0,
  adapter: 1,
  lineage: 2,
  bytes: 3,
  blob: 4,
  genesis: 5,
  parent: 6,
  settles: 7,
} as const;

/** Both 16-byte ids — lineage, action — are this long on the wire. */
export const ID16_LENGTH = 16;

export const SHA256_LENGTH = 32;

/** A peer id's key, on the wire. */
const PEER_LENGTH = 32;

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
  if (change.genesis === true) data.set(DOC.genesis, genesisToCbor(change));
  if (change.parent !== undefined) data.set(DOC.parent, hexToBytes(change.parent).unwrap());
  if (change.settles !== undefined) data.set(DOC.settles, settlesToCbor(change.settles));
  return data;
}

/** Key 5: the `true` of the rule before §16.1, or the version of the rule the genesis was written under. */
const genesisToCbor = (change: DocChange): CborValue => {
  if (change.legacy === true) return true;
  return change.settles === undefined ? GENESIS_RULE : SETTLED_RULE;
};

/** Key 7: `[lineage bstr(16), ms, logical, peer bstr(32)]` — the anchor and its genesis's stamp (gaps U21). */
const settlesToCbor = ({ lineage, stamp }: SettledLineage): CborValue => [
  hexToBytes(lineage).unwrap(),
  stamp.hlc[0].epochMilliseconds,
  stamp.hlc[1],
  hexToBytes(stamp.peer).unwrap(),
];

/** Key 7 back, or a refusal for anything {@link settlesToCbor} never writes. */
function settlesFromCbor(value: CborValue): Result<SettledLineage, MalformedDoc> {
  if (!Array.isArray(value) || value.length !== 4)
    return malformed("settles is not [lineage, ms, logical, peer]");
  const [lineage, ms, logical, peer] = value;
  const lineageId = id16(lineage);
  if (lineageId === undefined) return malformed("the settled lineage is not 16 bytes");
  if (!isSafeNonNegative(ms) || !isSafeNonNegative(logical) || logical > LOGICAL_MAX)
    return malformed("the settled stamp is not an HLC");
  if (!(peer instanceof Uint8Array) || peer.length !== PEER_LENGTH)
    return malformed("the settled stamp's peer is not 32 bytes");
  const author = parsePeerId(bytesToHex(peer));
  if (author.isErr()) return malformed("the settled stamp's peer is not a peer id");
  return Result.ok({
    lineage: parseLineageId(lineageId).unwrap(),
    stamp: { hlc: hlcOf(ms, logical), peer: author.value },
  });
}

/**
 * A doc change from its `data` map. Refuses what no fold could take — no column, no adapter, a
 * lineage or parent that is not 16 bytes, both or neither of `bytes` and `blob`, a `genesis` that
 * is neither {@link GENESIS_RULE}, {@link SETTLED_RULE} (with its anchor, key 7) nor the `true` of
 * the rule before them, a parent or an anchor on anything but a genesis — and skips keys it has no
 * name for. A `true` genesis decodes as `legacy`, so a stored
 * log that holds one still reads; admission is what refuses it. Never throws.
 */
export function docFromCbor(
  table: TableName,
  key: RowKey,
  value: CborValue | undefined,
): Result<DocChange, MalformedDoc> {
  if (!(value instanceof Map)) return malformed("doc data is not a map");
  const column = value.get(DOC.column);
  const adapter = value.get(DOC.adapter);
  const bytes = value.get(DOC.bytes);
  const blob = value.get(DOC.blob);
  if (!isString(column) || column.length === 0) return malformed("doc column is not text");
  if (!isString(adapter)) return malformed("doc adapter is not text");
  const adapterId = parseAdapterId(adapter);
  if (adapterId.isErr()) return malformed(`doc adapter: ${adapterId.error.message}`);
  if ((bytes === undefined) === (blob === undefined))
    return malformed("a doc change carries exactly one of bytes and blob");
  if (bytes !== undefined && !(bytes instanceof Uint8Array))
    return malformed("doc bytes are not bytes");
  const update: Result<DocUpdate, MalformedDoc> =
    bytes instanceof Uint8Array
      ? Result.ok({ bytes })
      : blobFromCbor(blob).map((ref) => ({ blob: ref }));
  return Result.gen(function* () {
    const carried = yield* update;
    const history = yield* historyFromCbor(value);
    return Result.ok({
      kind: "doc" as const,
      table,
      key,
      column: asColumn(column),
      adapter: adapterId.value,
      update: carried,
      ...history,
    });
  });
}

/**
 * Which history a change belongs to: keys 2, 5, 6 and 7 — its lineage, and on a genesis, the rule
 * it was written under, its parent and the anchor it settles the walk at.
 */
type History = Pick<DocChange, "lineage" | "genesis" | "legacy" | "parent" | "settles">;

/**
 * Keys 5 and 7: no genesis; {@link GENESIS_RULE} with no anchor; {@link SETTLED_RULE} with one
 * (gaps U21); or the `true` of the rule before §16.1 (`legacy`). An anchor under any other key 5
 * is refused, so no build folds a settling genesis without trimming what it settles.
 */
function genesisFromCbor(
  value: CborValue | undefined,
  settles: CborValue | undefined,
): Result<History, MalformedDoc> {
  if (settles !== undefined && value !== SETTLED_RULE)
    return malformed("only a genesis of rule 2 settles the walk");
  if (value === undefined) return Result.ok({});
  if (value === GENESIS_RULE) return Result.ok({ genesis: true });
  if (value === true) return Result.ok({ genesis: true, legacy: true });
  if (value !== SETTLED_RULE) return malformed("genesis is 1 or 2, the lineage rule's version");
  if (settles === undefined) return malformed("a genesis of rule 2 names the lineage it settles");
  return settlesFromCbor(settles).map((anchor) => ({ genesis: true as const, settles: anchor }));
}

function historyFromCbor(data: Map<CborKey, CborValue>): Result<History, MalformedDoc> {
  const lineage = data.get(DOC.lineage);
  const parent = data.get(DOC.parent);
  const rule = genesisFromCbor(data.get(DOC.genesis), data.get(DOC.settles));
  if (rule.isErr()) return rule;
  const lineageId = lineage === undefined ? undefined : id16(lineage);
  if (lineage !== undefined && lineageId === undefined)
    return malformed("doc lineage is not 16 bytes");
  const parentId = parent === undefined ? undefined : id16(parent);
  if (parent !== undefined && parentId === undefined)
    return malformed("doc parent is not 16 bytes");
  if (parent !== undefined && rule.value.genesis === undefined)
    return malformed("only a genesis names the lineage it replaces");
  return Result.ok({
    ...(lineageId !== undefined && { lineage: parseLineageId(lineageId).unwrap() }),
    ...rule.value,
    ...(parentId !== undefined && { parent: parseLineageId(parentId).unwrap() }),
  });
}

// SAFETY: column naming rules are owned by the schema; the codec only requires non-empty text
const asColumn = (s: string) => s as ColumnName;

/**
 * An action id from event key 10 or 11, or `undefined` for a value that is not 16 bytes. Lenient
 * on purpose: an old build skips both keys and folds the event, so a new one that refused the
 * event over them would park what every old peer folded — the divergence D13 exists to prevent.
 */
export const wireActionId = (value: CborValue | undefined) => {
  const hex = id16(value);
  return hex === undefined ? undefined : parseActionId(hex).unwrapOr(undefined);
};

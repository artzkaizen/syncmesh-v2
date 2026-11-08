import type {
  AdapterId,
  ColumnName,
  DocBlobRef,
  Hlc,
  LineageId,
  PeerId,
  Row,
  RowKey,
  SeqNum,
  TableName,
} from "@syncmesh/kernel";

import { hlcOf, parseAdapterId, parseLineageId, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import type { CborKey, CborValue } from "./cbor.js";

import { decodeCbor, type MalformedCbor } from "./cbor-decode.js";
import { isSafeNonNegative, isString } from "./cbor-guards.js";
import { compareKeys, encodeCbor } from "./cbor.js";
import { blobFromCbor, blobToCbor, id16 } from "./doc-codec.js";
import { splitEnvelope, type MalformedEnvelope } from "./envelope.js";
import { bytesToHex, hexToBytes } from "./hex.js";
import { verify, type Identity } from "./identity.js";
import { rowFromCbor, rowToCbor } from "./row-codec.js";

/**
 * The snapshot record (RFC-0023 §5.5): what a joiner below a compaction floor, or an opaque
 * authority, installs in place of a document's history. Signed by whoever produced it; who is
 * trusted to is the receiver's question (§7.3), not the codec's.
 */
export interface DocCheckpoint {
  readonly table: TableName;
  readonly key: RowKey;
  readonly column: ColumnName;
  readonly adapter: AdapterId;
  /** Absent is the root lineage. */
  readonly lineage?: LineageId;
  /** Every doc change of this document at or below these is folded into the snapshot. */
  readonly covers: ReadonlyMap<PeerId, SeqNum>;
  /** The adapter's own encoding of the snapshot's version. */
  readonly version: Uint8Array;
  /** The snapshot bytes, by reference (D18) — a snapshot is never inline. */
  readonly snapshot: DocBlobRef;
  /** The derived columns' values at this version, for hosts that cannot compute them. */
  readonly derived: Row;
  /** When it was produced. */
  readonly at: Hlc;
}

/** `DocCheckpoint` core keys, frozen by the vectors. */
const CHECKPOINT = {
  table: 0,
  key: 1,
  column: 2,
  adapter: 3,
  lineage: 4,
  covers: 5,
  version: 6,
  snapshot: 7,
  derived: 8,
  at: 9,
} as const;

export class MalformedCheckpoint extends TaggedError("MalformedCheckpoint")<{
  message: string;
}> {}

export class BadCheckpointSignature extends TaggedError("BadCheckpointSignature")<{
  message: string;
}> {}

const badCheckpoint = (message: string) => Result.err(new MalformedCheckpoint({ message }));

/**
 * `covers` as `[[peer, seq], …]`, ascending by the peer's bytes: the canonical CBOR here keys a
 * map by integer or text only, and a peer is 32 bytes everywhere else on this wire.
 */
const coversToCbor = (covers: ReadonlyMap<PeerId, SeqNum>): CborValue =>
  [...covers]
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([peer, seq]) => [hexToBytes(peer).unwrap(), seq]);

function coversFromCbor(
  value: CborValue | undefined,
): Result<ReadonlyMap<PeerId, SeqNum>, MalformedCheckpoint> {
  if (!Array.isArray(value)) return badCheckpoint("covers is not an array");
  const covers = new Map<PeerId, SeqNum>();
  let previous: string | undefined;
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) return badCheckpoint("a cover is not a pair");
    const [peer, seq] = pair;
    if (!(peer instanceof Uint8Array)) return badCheckpoint("a cover's peer is not bytes");
    const peerId = parsePeerId(bytesToHex(peer));
    if (peerId.isErr()) return badCheckpoint(peerId.error.message);
    // one order, no repeats: the same covers must be the same bytes, or a signature over them
    // means nothing a second encoder could reproduce
    if (previous !== undefined && compareKeys(previous, peerId.value) >= 0)
      return badCheckpoint("covers are not in ascending peer order");
    previous = peerId.value;
    if (!isSafeNonNegative(seq)) return badCheckpoint("a cover's seq is not an integer");
    const seqNum = parseSeqNum(seq);
    if (seqNum.isErr()) return badCheckpoint(seqNum.error.message);
    covers.set(peerId.value, seqNum.value);
  }
  return Result.ok(covers);
}

/** The checkpoint core, the bytes a producer signs. */
export function encodeCheckpointCore(checkpoint: DocCheckpoint): Uint8Array {
  const core = new Map<CborKey, CborValue>([
    [CHECKPOINT.table, checkpoint.table],
    [CHECKPOINT.key, checkpoint.key],
    [CHECKPOINT.column, checkpoint.column],
    [CHECKPOINT.adapter, checkpoint.adapter],
    [CHECKPOINT.covers, coversToCbor(checkpoint.covers)],
    [CHECKPOINT.version, checkpoint.version],
    [CHECKPOINT.snapshot, blobToCbor(checkpoint.snapshot)],
    [CHECKPOINT.derived, rowToCbor(checkpoint.derived)],
    [CHECKPOINT.at, [checkpoint.at[0].epochMilliseconds, checkpoint.at[1]]],
  ]);
  if (checkpoint.lineage !== undefined)
    core.set(CHECKPOINT.lineage, hexToBytes(checkpoint.lineage).unwrap());
  return encodeCbor(core);
}

type Address = Pick<DocCheckpoint, "table" | "key" | "column" | "adapter" | "lineage">;

/** Which document the checkpoint is of: the core's first five keys. */
function addressOf(value: ReadonlyMap<CborKey, CborValue>): Result<Address, MalformedCheckpoint> {
  const table = value.get(CHECKPOINT.table);
  const key = value.get(CHECKPOINT.key);
  const column = value.get(CHECKPOINT.column);
  const adapter = value.get(CHECKPOINT.adapter);
  const lineage = value.get(CHECKPOINT.lineage);
  if (!isString(table) || !isString(key) || !isString(column))
    return badCheckpoint("table, key and column are text");
  if (!isString(adapter)) return badCheckpoint("adapter is not text");
  const adapterId = parseAdapterId(adapter);
  if (adapterId.isErr()) return badCheckpoint(adapterId.error.message);
  const lineageId = lineage === undefined ? undefined : id16(lineage);
  if (lineage !== undefined && lineageId === undefined)
    return badCheckpoint("lineage is not 16 bytes");
  const address = {
    table: asTable(table),
    key: asKey(key),
    column: asColumn(column),
    adapter: adapterId.value,
  };
  return Result.ok(
    lineageId === undefined ? address : { ...address, lineage: parseLineageId(lineageId).unwrap() },
  );
}

const asCheckpointError = (e: { readonly message: string }) =>
  new MalformedCheckpoint({ message: e.message });

/** Decodes a checkpoint core; ignores unknown keys. Never throws. */
export function decodeCheckpointCore(
  core: Uint8Array,
): Result<DocCheckpoint, MalformedCheckpoint | MalformedCbor> {
  return decodeCbor(core).andThen((value) =>
    Result.gen(function* () {
      if (!(value instanceof Map)) return badCheckpoint("checkpoint core is not a map");
      const address = yield* addressOf(value);
      const version = value.get(CHECKPOINT.version);
      const at = value.get(CHECKPOINT.at);
      if (!(version instanceof Uint8Array)) return badCheckpoint("version is not bytes");
      if (!Array.isArray(at) || at.length !== 2) return badCheckpoint("at is not a pair");
      const [ms, logical] = at;
      if (!isSafeNonNegative(ms) || !isSafeNonNegative(logical))
        return badCheckpoint("at is not two integers");
      const covers = yield* coversFromCbor(value.get(CHECKPOINT.covers));
      const snapshot = yield* blobFromCbor(value.get(CHECKPOINT.snapshot)).mapError(
        asCheckpointError,
      );
      const derived = yield* rowFromCbor(value.get(CHECKPOINT.derived)).mapError(asCheckpointError);
      return Result.ok({ ...address, covers, version, snapshot, derived, at: hlcOf(ms, logical) });
    }),
  );
}

/** A checkpoint signed by its producer, and the `[core, sig]` envelope it travels in. */
export interface SignedCheckpoint {
  readonly checkpoint: DocCheckpoint;
  readonly core: Uint8Array;
  readonly sig: Uint8Array;
  readonly wire: Uint8Array;
}

export function signCheckpoint(checkpoint: DocCheckpoint, producer: Identity): SignedCheckpoint {
  const core = encodeCheckpointCore(checkpoint);
  const sig = producer.sign(core);
  return { checkpoint, core, sig, wire: encodeCbor([core, sig]) };
}

/**
 * `[core, sig]` → the checkpoint, only if `producer`'s signature covers the received core. The
 * core does not name its producer, so the caller says whose signature it expects. Never throws.
 */
export function decodeCheckpoint(
  wire: Uint8Array,
  producer: PeerId,
): Result<
  SignedCheckpoint,
  MalformedCbor | MalformedEnvelope | MalformedCheckpoint | BadCheckpointSignature
> {
  return Result.gen(function* () {
    const { core, sig } = yield* splitEnvelope(wire);
    const checkpoint = yield* decodeCheckpointCore(core);
    if (!verify(core, sig, hexToBytes(producer).unwrap()))
      return Result.err(
        new BadCheckpointSignature({ message: "the producer's signature does not cover the core" }),
      );
    return Result.ok({ checkpoint, core, sig, wire });
  });
}

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- each brand below is applied right after the check that establishes it; naming rules for these identifiers are owned by the schema */
const asTable = (s: string) => s as TableName;
const asKey = (s: string) => s as RowKey;
const asColumn = (s: string) => s as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

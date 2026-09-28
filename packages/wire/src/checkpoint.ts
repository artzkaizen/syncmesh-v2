import type { PartitionKey, PeerId } from "@syncmesh/kernel";

import { sha256 } from "@noble/hashes/sha2.js";
import { parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import { decodeCbor, type MalformedCbor } from "./cbor-decode.js";
import { encodeCbor, type CborKey, type CborValue } from "./cbor.js";
import { MalformedEnvelope, splitEnvelope } from "./envelope.js";
import { bytesToHex, hexToBytes } from "./hex.js";
import { verify, type Identity } from "./identity.js";

/**
 * What vouches for a snapshot (book ch. 4). A snapshot's rows arrive with no per-event
 * signatures — that is what makes it a snapshot rather than history — so a device that installs
 * one holds state it cannot itself prove. The certificate is the other half: the authority signs
 * *which state* it is, and every receiver checks that signature against the issuer it was
 * shipped with, before adopting the coverage that stops it ever asking for those events again.
 *
 * A peer cannot mint one. A device handing a snapshot to another device relays the authority's
 * certificate unchanged; it cannot re-sign rows it altered, because the signature covers the
 * state hash and the key is not its own.
 */
export interface CheckpointCertificate {
  readonly v: 1;
  /** The slice this checkpoint is for; absent means the issuer's whole state. */
  readonly partition?: PartitionKey;
  /** {@link checkpointHash} over the rows the checkpoint stands for. */
  readonly stateHash: Uint8Array;
  /** Per author, the highest sequence the state folds — the coverage adopting this claims. */
  readonly coverage: ReadonlyMap<PeerId, number>;
  readonly issuedAt: Temporal.Instant;
  readonly issuer: PeerId;
}

/** Certificate core map keys; additive like every other core in this package. */
const KEY = {
  v: 0,
  partition: 1,
  stateHash: 2,
  coverage: 3,
  issuedAt: 4,
  issuer: 5,
} as const;

export class MalformedCheckpoint extends TaggedError("MalformedCheckpoint")<{ message: string }> {}
export class BadCheckpointSignature extends TaggedError("BadCheckpointSignature")<{
  message: string;
}> {}
/** The rows do not hash to what the certificate says — a page was altered, dropped or added. */
export class CheckpointMismatch extends TaggedError("CheckpointMismatch")<{
  expected: string;
  actual: string;
  message: string;
}> {}

export type CheckpointError =
  | MalformedCbor
  | MalformedCheckpoint
  | BadCheckpointSignature
  | CheckpointMismatch;

/** One row as a checkpoint counts it: where it lives, and the bytes the state store holds. */
export interface CheckpointRow {
  readonly table: string;
  readonly key: string;
  readonly record: Uint8Array;
}

/**
 * The state a certificate names, hashed so every receiver reaches the same answer: each row as
 * an unambiguous JSON triple, sorted, then folded in one pass.
 *
 * Sorted because two senders may page the same state in different orders and both are correct;
 * a hash that depended on that order would refuse honest snapshots while proving nothing about
 * dishonest ones. JSON rather than a delimiter, because a table name and a row key are
 * app-chosen strings and any separator picked here would be one an app could contain.
 */
export function checkpointHash(rows: readonly CheckpointRow[]): Uint8Array {
  const lines = rows
    .map((row) => JSON.stringify([row.table, row.key, bytesToHex(row.record)]))
    .sort();
  return sha256(new TextEncoder().encode(lines.join("\n")));
}

export function encodeCheckpoint(certificate: CheckpointCertificate): Uint8Array {
  const core = new Map<CborKey, CborValue>([
    [KEY.v, certificate.v],
    [KEY.stateHash, certificate.stateHash],
    // keyed by the peer's own hex, which is what a peer id already is — CBOR map keys are
    // text or integers, and a cursor map is exactly this shape everywhere else in the system
    [
      KEY.coverage,
      new Map<CborKey, CborValue>(
        [...certificate.coverage].map(([peer, seq]) => [String(peer), seq]),
      ),
    ],
    [KEY.issuedAt, certificate.issuedAt.epochMilliseconds],
    [KEY.issuer, hexToBytes(certificate.issuer).unwrap()],
  ]);
  if (certificate.partition !== undefined) core.set(KEY.partition, String(certificate.partition));
  return encodeCbor(core);
}

export interface CheckpointRequest {
  readonly partition?: PartitionKey;
  readonly stateHash: Uint8Array;
  readonly coverage: ReadonlyMap<PeerId, number>;
  readonly now: Temporal.Instant;
}

/** Mints a signed certificate as wire bytes: `[core, sig]`, the envelope events and grants use. */
export function issueCheckpoint(issuer: Identity, request: CheckpointRequest): Uint8Array {
  const base = {
    v: 1 as const,
    stateHash: request.stateHash,
    coverage: request.coverage,
    issuedAt: request.now,
    issuer: issuer.peerId,
  };
  const core = encodeCheckpoint(
    request.partition === undefined ? base : { ...base, partition: request.partition },
  );
  return encodeCbor([core, issuer.sign(core)]);
}

/**
 * Decodes and verifies against the received core bytes, then against the rows themselves when
 * they are offered. Never throws; a certificate that fails any check is refused, and the
 * snapshot it was carrying stays what it is without one — provisional.
 */
export function verifyCheckpoint(
  wire: Uint8Array,
  issuer: PeerId,
  rows?: readonly CheckpointRow[],
): Result<CheckpointCertificate, CheckpointError> {
  return Result.gen(function* () {
    const { core, sig } = yield* splitCheckpoint(wire);
    if (!verify(core, sig, hexToBytes(issuer).unwrap())) {
      return Result.err(
        new BadCheckpointSignature({
          message: "signature does not cover the received core, or is not the issuer's",
        }),
      );
    }
    const certificate = yield* decodeCbor(core).andThen(decodeCheckpointValue);
    if (rows === undefined) return Result.ok(certificate);
    const actual = bytesToHex(checkpointHash(rows));
    const expected = bytesToHex(certificate.stateHash);
    if (actual !== expected) {
      return Result.err(
        new CheckpointMismatch({
          expected,
          actual,
          message: "the rows do not hash to what this certificate vouches for",
        }),
      );
    }
    return Result.ok(certificate);
  });
}

const malformed = (message: string) => Result.err(new MalformedCheckpoint({ message }));

const splitCheckpoint = (wire: Uint8Array) =>
  splitEnvelope(wire).mapError((error) =>
    error instanceof MalformedEnvelope
      ? new MalformedCheckpoint({ message: error.message })
      : error,
  );

/* oxlint-disable anti-slop/no-runtime-typeof -- decoding CBOR is the I/O boundary: these checks are the parse */
function decodeCheckpointValue(
  value: CborValue,
): Result<CheckpointCertificate, MalformedCheckpoint> {
  if (!(value instanceof Map)) return malformed("checkpoint core is not a map");
  const stateHash = value.get(KEY.stateHash);
  const issuer = value.get(KEY.issuer);
  const issuedAt = value.get(KEY.issuedAt);
  const coverage = value.get(KEY.coverage);
  if (!(stateHash instanceof Uint8Array)) return malformed("stateHash is not bytes");
  if (!(issuer instanceof Uint8Array)) return malformed("issuer is not a peer id");
  if (typeof issuedAt !== "number") return malformed("issuedAt is not a timestamp");
  if (!(coverage instanceof Map)) return malformed("coverage is not a map");

  const held = new Map<PeerId, number>();
  for (const [peer, seq] of coverage) {
    if (typeof peer !== "string" || typeof seq !== "number")
      return malformed("coverage names a peer or a sequence it cannot read");
    const parsed = parsePeerId(peer);
    if (parsed.isErr()) return malformed(parsed.error.message);
    held.set(parsed.value, seq);
  }
  const author = parsePeerId(bytesToHex(issuer));
  if (author.isErr()) return malformed(author.error.message);

  const base = {
    v: 1 as const,
    stateHash,
    coverage: held,
    issuedAt: Temporal.Instant.fromEpochMilliseconds(issuedAt),
    issuer: author.value,
  };
  const partition = value.get(KEY.partition);
  if (partition === undefined) return Result.ok(base);
  if (typeof partition !== "string") return malformed("partition is not a key");
  const scope = parsePartitionKey(partition);
  if (scope.isErr()) return malformed(scope.error.message);
  return Result.ok({ ...base, partition: scope.value });
}
/* oxlint-enable anti-slop/no-runtime-typeof */

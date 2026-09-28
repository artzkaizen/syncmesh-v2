import type { JsonValue, PartitionKey, PeerId } from "@syncmesh/kernel";

import { parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { Temporal, addToInstant } from "@syncmesh/temporal";

import { decodeCbor, type MalformedCbor } from "./cbor-decode.js";
import { encodeCbor, type CborKey, type CborValue } from "./cbor.js";
import { MalformedEnvelope, splitEnvelope } from "./envelope.js";
import { bytesToHex, hexToBytes } from "./hex.js";
import { verify, type Identity } from "./identity.js";

/** What a grant says: this device belongs to this account, with these rights, until then. See D08. */
export interface Grant {
  readonly v: 1;
  readonly account: string;
  readonly device: PeerId;
  readonly role?: string;
  readonly partitions: readonly PartitionKey[];
  readonly issuedAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
  /** Free-form facts the issuing server vouches for; `allow` rules read them. */
  readonly claims: Readonly<Record<string, JsonValue>>;
  /**
   * Content keys for the sealed partitions this grant admits, each wrapped to this grant's
   * device (book ch. 14). Absent for a grant over no sealed partition, which is most of them.
   *
   * The grant is the key's carrier because it is already the thing that says which device may
   * see which partition. A second channel would be a second answer to that question, and the two
   * would eventually disagree — a device holding a key for a partition its grant no longer
   * covers is exactly the state sealing exists to prevent.
   */
  readonly keys?: readonly WrappedKey[];
}

/**
 * One partition's content key for one epoch, sealed to this grant's device.
 *
 * A list of these rather than one per partition, because rotation means a device usually needs
 * **more than one**: the newest epoch to write under, and the older ones to read what it already
 * carries. A grant that handed over only the current key would make every past event unreadable
 * the moment the partition rotated.
 */
export interface WrappedKey {
  readonly partition: PartitionKey;
  readonly epoch: number;
  readonly wrapped: Uint8Array;
}

/** Grant core map keys, frozen by the grant vectors. */
const KEY = {
  v: 0,
  account: 1,
  device: 2,
  role: 3,
  partitions: 4,
  issuedAt: 5,
  expiresAt: 6,
  claims: 7,
  /** Additive: a build with no name for this key ignores it and holds no key, which is custody. */
  keys: 8,
} as const;

export class MalformedGrant extends TaggedError("MalformedGrant")<{ message: string }> {}
export class BadGrantSignature extends TaggedError("BadGrantSignature")<{ message: string }> {}
export class GrantExpired extends TaggedError("GrantExpired")<{
  expiresAt: Temporal.Instant;
  message: string;
}> {}

export type GrantError = MalformedCbor | MalformedGrant | BadGrantSignature | GrantExpired;

export interface GrantRequest {
  readonly account: string;
  readonly device: PeerId;
  readonly role?: string;
  readonly partitions: readonly PartitionKey[];
  readonly claims?: Readonly<Record<string, JsonValue>>;
  /**
   * Content keys for sealed partitions, already wrapped to `device` with {@link wrapKey}. The
   * issuer holds the partition's keys; this grant is how one device gets its copies.
   */
  readonly keys?: readonly WrappedKey[];
  readonly validFor: Temporal.Duration;
  readonly now: Temporal.Instant;
}

export function encodeGrant(grant: Grant): Uint8Array {
  const core = new Map<CborKey, CborValue>([
    [KEY.v, grant.v],
    [KEY.account, grant.account],
    [KEY.device, hexToBytes(grant.device).unwrap()],
    [KEY.partitions, [...grant.partitions]],
    [KEY.issuedAt, grant.issuedAt.epochMilliseconds],
    [KEY.expiresAt, grant.expiresAt.epochMilliseconds],
    [KEY.claims, jsonToCbor(grant.claims)],
  ]);
  if (grant.role !== undefined) core.set(KEY.role, grant.role);
  if (grant.keys !== undefined && grant.keys.length > 0)
    core.set(
      KEY.keys,
      grant.keys.map((key): CborValue => [key.partition, key.epoch, key.wrapped]),
    );
  return encodeCbor(core);
}

/** Mints a signed grant as wire bytes: `[core, sig]`, the same envelope events use. */
export function issueGrant(issuer: Identity, request: GrantRequest): Uint8Array {
  const base = {
    v: 1 as const,
    account: request.account,
    device: request.device,
    partitions: request.partitions,
    issuedAt: request.now,
    expiresAt: addToInstant(request.now, request.validFor),
    claims: request.claims ?? {},
    ...(request.keys !== undefined && { keys: request.keys }),
  };
  const core = encodeGrant(request.role === undefined ? base : { ...base, role: request.role });
  return encodeCbor([core, issuer.sign(core)]);
}

/** Decodes and verifies against the received core bytes; expiry is judged against the caller's `now`. Never throws. */
export function verifyGrant(
  wire: Uint8Array,
  issuer: PeerId,
  now: Temporal.Instant,
): Result<Grant, GrantError> {
  return Result.gen(function* () {
    const { core, sig } = yield* splitGrant(wire);
    if (!verify(core, sig, hexToBytes(issuer).unwrap())) {
      return Result.err(
        new BadGrantSignature({
          message: "signature does not cover the received core, or is not the issuer's",
        }),
      );
    }
    const grant = yield* decodeCbor(core).andThen(decodeGrantValue);
    if (Temporal.Instant.compare(now, grant.expiresAt) > 0) {
      return Result.err(
        new GrantExpired({
          expiresAt: grant.expiresAt,
          message: `expired at ${grant.expiresAt.toString()}`,
        }),
      );
    }
    return Result.ok(grant);
  });
}

const malformed = (message: string) => Result.err(new MalformedGrant({ message }));

/** The shared envelope split, reported in this module's vocabulary so `GrantError` stays closed. */
const splitGrant = (wire: Uint8Array) =>
  splitEnvelope(wire).mapError((error) =>
    error instanceof MalformedEnvelope ? new MalformedGrant({ message: error.message }) : error,
  );

/** Which device a grant is for and when it was minted — enough to order two of them. */
export interface GrantOrigin {
  readonly device: PeerId;
  readonly issuedAt: Temporal.Instant;
}

/**
 * Reads a grant's device and mint time *without* checking its signature, for a hop that routes
 * grants but holds no issuer key — the relay (D09/D14), which keys its per-room cache by device
 * so a re-issued, narrower grant supersedes the broad one it replaces instead of circulating
 * beside it forever. Safe there precisely because no right follows from what it reads: every
 * receiver puts the same bytes through `GrantRegistry.register`, which does verify, so a forged
 * core buys a liar nothing but the eviction of its own cache entry. Anything that decides what a
 * device may do must call `verifyGrant` instead.
 */
export function readGrantOrigin(
  wire: Uint8Array,
): Result<GrantOrigin, MalformedCbor | MalformedGrant> {
  return Result.gen(function* () {
    const core = yield* splitGrant(wire).map((split) => split.core);
    const value = yield* decodeCbor(core);
    if (!(value instanceof Map)) return malformed("core is not a map");
    const device = value.get(KEY.device);
    const issuedAt = value.get(KEY.issuedAt);
    if (!(device instanceof Uint8Array)) return malformed("device is not bytes");
    if (!isMs(issuedAt)) return malformed("issuedAt is not epoch ms");
    const peer = yield* parsePeerId(bytesToHex(device)).mapError(
      (e) => new MalformedGrant({ message: e.message }),
    );
    return Result.ok({
      device: peer,
      issuedAt: Temporal.Instant.fromEpochMilliseconds(issuedAt),
    });
  });
}

function decodeGrantValue(value: CborValue): Result<Grant, MalformedGrant> {
  if (!(value instanceof Map)) return malformed("core is not a map");
  if (value.get(KEY.v) !== 1) return malformed("unsupported version");
  const account = value.get(KEY.account);
  const device = value.get(KEY.device);
  const role = value.get(KEY.role);
  const partitions = value.get(KEY.partitions);
  const issuedAt = value.get(KEY.issuedAt);
  const expiresAt = value.get(KEY.expiresAt);
  const claims = value.get(KEY.claims);
  if (!isString(account) || account.length === 0) return malformed("account is not text");
  if (!(device instanceof Uint8Array)) return malformed("device is not bytes");
  if (role !== undefined && !isString(role)) return malformed("role is not text");
  if (!Array.isArray(partitions)) return malformed("partitions is not a list");
  if (!isMs(issuedAt) || !isMs(expiresAt) || issuedAt > expiresAt)
    return malformed("validity window is not two ordered epoch ms");
  return Result.gen(function* () {
    const peer = yield* parsePeerId(bytesToHex(device)).mapError(
      (e) => new MalformedGrant({ message: e.message }),
    );
    const keys: PartitionKey[] = [];
    for (const p of partitions) {
      if (!isString(p)) return malformed("partition is not text");
      keys.push(
        yield* parsePartitionKey(p).mapError((e) => new MalformedGrant({ message: e.message })),
      );
    }
    const wrapped = yield* decodeKeys(value.get(KEY.keys));
    const parsedClaims = yield* jsonFromCbor(claims ?? new Map());
    if (parsedClaims === null || Array.isArray(parsedClaims) || !isObject(parsedClaims))
      return malformed("claims is not an object");
    const base = {
      v: 1 as const,
      account,
      device: peer,
      partitions: keys,
      issuedAt: Temporal.Instant.fromEpochMilliseconds(issuedAt),
      expiresAt: Temporal.Instant.fromEpochMilliseconds(expiresAt),
      claims: parsedClaims,
      ...(wrapped.length > 0 && { keys: wrapped }),
    };
    return Result.ok(role === undefined ? base : { ...base, role });
  });
}

/** `[[partition, epoch, wrapped], …]`, or nothing — which is what a grant over no seal carries. */
function decodeKeys(value: CborValue | undefined): Result<WrappedKey[], MalformedGrant> {
  const keys: WrappedKey[] = [];
  if (value === undefined) return Result.ok(keys);
  if (!Array.isArray(value)) return malformed("keys is not a list");
  return Result.gen(function* () {
    for (const entry of value) {
      if (!Array.isArray(entry) || entry.length < 3) return malformed("a key is not a triple");
      const [partition, epoch, wrapped] = entry;
      if (!isString(partition)) return malformed("a key's partition is not text");
      if (!isMs(epoch)) return malformed("a key's epoch is not a count");
      if (!(wrapped instanceof Uint8Array)) return malformed("a wrapped key is not bytes");
      keys.push({
        partition: yield* parsePartitionKey(partition).mapError(
          (e) => new MalformedGrant({ message: e.message }),
        ),
        epoch,
        wrapped,
      });
    }
    return Result.ok(keys);
  });
}

/* oxlint-disable anti-slop/no-runtime-typeof -- decoding is the I/O boundary; these are the parsers */
const isString = (v: CborValue | undefined): v is string => typeof v === "string";
const isMs = (v: CborValue | undefined): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isObject = (v: JsonValue): v is { readonly [key: string]: JsonValue } =>
  typeof v === "object" && v !== null;

const jsonToCbor = (v: JsonValue): CborValue => {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(jsonToCbor);
  return new Map<CborKey, CborValue>(Object.entries(v).map(([k, x]) => [k, jsonToCbor(x)]));
};

function jsonFromCbor(value: CborValue): Result<JsonValue, MalformedGrant> {
  if (value === null || typeof value !== "object") return Result.ok(value);
  if (value instanceof Uint8Array) return malformed("claims cannot carry bytes");
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const decoded = jsonFromCbor(item);
      if (decoded.isErr()) return decoded;
      items.push(decoded.value);
    }
    return Result.ok(items);
  }
  if (!(value instanceof Map)) return malformed("unsupported claim shape");
  const object: Record<string, JsonValue> = {};
  for (const [k, x] of value) {
    if (!isString(k)) return malformed("claim keys must be text");
    const decoded = jsonFromCbor(x);
    if (decoded.isErr()) return decoded;
    object[k] = decoded.value;
  }
  return Result.ok(object);
}
/* oxlint-enable anti-slop/no-runtime-typeof */

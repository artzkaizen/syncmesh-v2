import type { JsonValue, PartitionKey, PeerId } from "@syncmesh/kernel";

import { parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { Temporal, addToInstant } from "@syncmesh/temporal";

import { decodeCbor, type MalformedCbor } from "./cbor-decode.js";
import { encodeCbor, type CborKey, type CborValue } from "./cbor.js";
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
    const outer = yield* decodeCbor(wire);
    if (!Array.isArray(outer) || outer.length !== 2)
      return Result.err(new MalformedGrant({ message: "expected [core, sig]" }));
    const [core, sig] = outer;
    if (!(core instanceof Uint8Array) || !(sig instanceof Uint8Array)) {
      return Result.err(new MalformedGrant({ message: "core and sig must be byte strings" }));
    }
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
    };
    return Result.ok(role === undefined ? base : { ...base, role });
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

import type { PeerId, Row } from "@syncmesh/kernel";

import { parsePeerId, type PartitionKey } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import type { CborKey, CborValue } from "./cbor.js";
import type { Identity } from "./identity.js";

import { decodeCbor, type MalformedCbor } from "./cbor-decode.js";
import { isSafeNonNegative, isString } from "./cbor-guards.js";
import { encodeCbor } from "./cbor.js";
import { bytesToHex, hexToBytes } from "./hex.js";
import { verify } from "./identity.js";
import { rowFromCbor, rowToCbor } from "./row-codec.js";

export class MalformedPresence extends TaggedError("MalformedPresence")<{ message: string }> {}

/**
 * The ephemeral tier (D16): a cursor, a typing flag, who-is-here. Signed like an event, so a
 * relay cannot forge one — and nothing else like an event: never appended, never folded, never
 * snapshotted, never in catch-up. The engine does not know this exists.
 */
export interface Presence {
  readonly v: 1;
  readonly peerId: PeerId;
  /** The manifest topic this value belongs to. */
  readonly topic: string;
  readonly partition: PartitionKey;
  /** Random per process start; with `count`, what makes a gossip loop terminate. */
  readonly session: string;
  /** Monotonic within a session: a receiver keeps the highest it has seen and drops the rest. */
  readonly count: number;
  /** The value as its topic's shape; `null` is an explicit departure. */
  readonly value: Row | null;
  /** Epoch milliseconds after which this value is stale, whoever holds it. */
  readonly expires: number;
}

/** Presence core map keys, in the same style as the event core (RFC-0002). */
const KEY = {
  v: 0,
  peerId: 1,
  topic: 2,
  partition: 3,
  session: 4,
  count: 5,
  value: 6,
  expires: 7,
} as const;

export function encodePresenceCore(presence: Presence): Uint8Array {
  return encodeCbor(
    new Map<CborKey, CborValue>([
      [KEY.v, presence.v],
      [KEY.peerId, hexToBytes(presence.peerId).unwrap()],
      [KEY.topic, presence.topic],
      [KEY.partition, String(presence.partition)],
      [KEY.session, presence.session],
      [KEY.count, presence.count],
      [KEY.value, presence.value === null ? null : rowToCbor(presence.value)],
      [KEY.expires, presence.expires],
    ]),
  );
}

/** An ephemeral value together with the bytes it travels as; forward `wire`, never re-encode. */
export interface VerifiedPresence {
  readonly presence: Presence;
  readonly wire: Uint8Array;
}

export function signPresence(presence: Presence, identity: Identity): VerifiedPresence {
  const core = encodePresenceCore(presence);
  return { presence, wire: encodeCbor([core, identity.sign(core)]) };
}

const malformed = (message: string) => Result.err(new MalformedPresence({ message }));

/** `[core, sig]` → the value, only if the signature covers the received core bytes. Never throws. */
export function decodeAndVerifyPresence(
  wire: Uint8Array,
): Result<VerifiedPresence, MalformedPresence | MalformedCbor> {
  return Result.gen(function* () {
    const outer = yield* decodeCbor(wire);
    if (!Array.isArray(outer) || outer.length !== 2) return malformed("expected [core, sig]");
    const [core, sig] = outer;
    if (!(core instanceof Uint8Array) || !(sig instanceof Uint8Array))
      return malformed("core and sig must be byte strings");
    const presence = yield* decodePresenceCore(core);
    if (!verify(core, sig, hexToBytes(presence.peerId).unwrap()))
      return malformed("signature does not cover the received core");
    return Result.ok({ presence, wire });
  });
}

/** Decodes a core; refuses `v ≠ 1`; ignores unknown keys. */
export function decodePresenceCore(
  core: Uint8Array,
): Result<Presence, MalformedPresence | MalformedCbor> {
  return decodeCbor(core).andThen(decodePresenceValue);
}

function decodePresenceValue(value: CborValue): Result<Presence, MalformedPresence> {
  if (!(value instanceof Map)) return malformed("core is not a map");
  const m = value;
  if (m.get(KEY.v) !== 1) return malformed("unsupported version");
  const peerBytes = m.get(KEY.peerId);
  if (!(peerBytes instanceof Uint8Array)) return malformed("peerId is not bytes");
  const topic = m.get(KEY.topic);
  const partition = m.get(KEY.partition);
  const session = m.get(KEY.session);
  const count = m.get(KEY.count);
  const expires = m.get(KEY.expires);
  if (!isString(topic) || !isString(partition) || !isString(session))
    return malformed("topic, partition and session must be text");
  if (!isSafeNonNegative(count) || !isSafeNonNegative(expires))
    return malformed("count and expires must be non-negative integers");
  return Result.gen(function* () {
    const peerId = yield* parsePeerId(bytesToHex(peerBytes)).mapError(
      (e) => new MalformedPresence({ message: e.message }),
    );
    const raw = m.get(KEY.value);
    const row =
      raw === null || raw === undefined
        ? null
        : yield* rowFromCbor(raw).mapError((e) => new MalformedPresence({ message: e.message }));
    return Result.ok({
      v: 1 as const,
      peerId,
      topic,
      // SAFETY: the partition is a kind:id string the sender parsed before it ever sent one; a receiver treats it as opaque
      partition: partition as PartitionKey,
      session,
      count,
      value: row,
      expires,
    });
  });
}

import type { PartitionKey, PeerId } from "@syncmesh/kernel";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Result, TaggedError } from "@syncmesh/result";

import type { Identity } from "./identity.js";

import { hexToBytes } from "./hex.js";

/**
 * Sealing: custody without judgment (book ch. 14).
 *
 * A sealed partition's events travel as opaque payloads. Every carrier — another device, a
 * relay, the server's custody role — holds the envelope, checks the author's signature, stores
 * it, relays it and counts it towards coverage, and cannot read a single value in it. What it
 * cannot do is judge: folding into Postgres, watchdogs and corrections are *structurally*
 * unavailable for that scope, because a judge has to read.
 *
 * **What is still visible, and it matters.** The author, the sequence number, the clock stamp
 * and the partition stay in the clear, because routing, admission and ordering are done by
 * devices that hold no key. What a sealed partition hides is content: which tables, which rows,
 * which columns and which values. Nothing here hides that *somebody wrote something*.
 *
 * The trade is per partition and it is stated, not hidden: sealing buys operator-proof custody
 * and costs server-side judgment.
 */

/** The symmetric key one sealed partition's content is under, in one epoch of its life. */
export type ContentKey = Uint8Array;

/**
 * Which key a sealed payload is under.
 *
 * **Rotation is what makes revoking a device mean anything here.** A device that once held a
 * partition's key holds it forever — nothing can reach into it and take it back. What an issuer
 * can do is mint the next epoch and leave that device out of it: the revoked device keeps
 * whatever it already carried, and reads nothing written after the turn.
 *
 * A small integer rather than a key id, because the order is the point: a writer seals under the
 * newest epoch it holds, and a reader tries the one the payload names. Both are decisions that
 * need "later", and nothing else.
 */
export type KeyEpoch = number;

/** The epoch of a partition that has never rotated, which is most of them. */
export const FIRST_EPOCH = 1;

export const CONTENT_KEY_BYTES = 32;
const NONCE_BYTES = 24;
const EPHEMERAL_BYTES = 32;
const EPOCH_BYTES = 2;

export class SealFailed extends TaggedError("SealFailed")<{ message: string }> {}

/** A fresh content key. The issuer mints one per sealed partition and hands it out in grants. */
export const newContentKey = (): ContentKey => randomBytes(CONTENT_KEY_BYTES);

/**
 * Seals a payload under a partition's content key.
 *
 * `aad` is the part of the envelope that stays in the clear — the author, the sequence and the
 * partition. Binding it here is what stops a sealed payload being lifted out of one event and
 * dropped into another: the signature covers the whole core, so a lift would fail verification
 * anyway, but a payload that authenticates its own place needs no argument about which check
 * happens first.
 */
export const sealPayload = (
  key: ContentKey,
  plain: Uint8Array,
  aad: Uint8Array,
  epoch: KeyEpoch = FIRST_EPOCH,
  nonce: Uint8Array = randomBytes(NONCE_BYTES),
): Uint8Array => {
  const sealed = xchacha20poly1305(key, nonce, aad).encrypt(plain);
  const out = new Uint8Array(EPOCH_BYTES + nonce.length + sealed.length);
  // the epoch travels in the clear and is covered by nothing: it names which key to try, and a
  // reader that is lied to simply fails to open the payload, which is the same answer as before
  new DataView(out.buffer).setUint16(0, epoch);
  out.set(nonce, EPOCH_BYTES);
  out.set(sealed, EPOCH_BYTES + nonce.length);
  return out;
};

/** Which epoch's key a sealed payload wants, or `undefined` when it is not one. */
export const epochOf = (sealed: Uint8Array): KeyEpoch | undefined =>
  sealed.length <= EPOCH_BYTES + NONCE_BYTES
    ? undefined
    : new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength).getUint16(0);

/** The payload behind a seal, or a failure — a wrong key and a tampered payload look the same. */
export const openPayload = (
  key: ContentKey,
  sealed: Uint8Array,
  aad: Uint8Array,
): Result<Uint8Array, SealFailed> => {
  if (sealed.length <= EPOCH_BYTES + NONCE_BYTES)
    return Result.err(new SealFailed({ message: "a sealed payload is shorter than its header" }));
  return Result.try({
    try: () =>
      xchacha20poly1305(key, sealed.subarray(EPOCH_BYTES, EPOCH_BYTES + NONCE_BYTES), aad).decrypt(
        sealed.subarray(EPOCH_BYTES + NONCE_BYTES),
      ),
    // the key is wrong, or somebody changed the bytes; from here the two are the same fact
    catch: () => new SealFailed({ message: "this payload does not open under that key" }),
  });
};

/** What a content key is sealed under when it travels to one device: HKDF over the agreement. */
const wrappingKey = (shared: Uint8Array, device: PeerId): Uint8Array =>
  hkdf(sha256, shared, undefined, hexToBytes(device).unwrap(), CONTENT_KEY_BYTES);

/**
 * Seals a content key to one device, so it can ride inside that device's grant.
 *
 * Sealed to the device's own key rather than to an account: a grant names one device, and a key
 * that arrived for a device the issuer did not mean to admit is a key nobody can take back.
 * A fresh ephemeral per wrap, so two devices' copies of one key share nothing an observer can use.
 */
export const wrapKey = (device: PeerId, key: ContentKey): Uint8Array => {
  const ephemeral = x25519.utils.randomSecretKey();
  const theirs = ed25519.utils.toMontgomery(hexToBytes(device).unwrap());
  const shared = x25519.getSharedSecret(ephemeral, theirs);
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = xchacha20poly1305(wrappingKey(shared, device), nonce).encrypt(key);
  const out = new Uint8Array(EPHEMERAL_BYTES + nonce.length + sealed.length);
  out.set(x25519.getPublicKey(ephemeral), 0);
  out.set(nonce, EPHEMERAL_BYTES);
  out.set(sealed, EPHEMERAL_BYTES + nonce.length);
  return out;
};

/** The content key inside a wrap addressed to this device; a failure for anyone else's. */
export const unwrapKey = (
  identity: Identity,
  wrapped: Uint8Array,
): Result<ContentKey, SealFailed> =>
  Result.try({
    try: () => {
      const shared = identity.agree(wrapped.subarray(0, EPHEMERAL_BYTES));
      const nonce = wrapped.subarray(EPHEMERAL_BYTES, EPHEMERAL_BYTES + NONCE_BYTES);
      const body = wrapped.subarray(EPHEMERAL_BYTES + NONCE_BYTES);
      return xchacha20poly1305(wrappingKey(shared, identity.peerId), nonce).decrypt(body);
    },
    catch: () => new SealFailed({ message: "this wrapped key is not for this device" }),
  });

/**
 * What an envelope does about sealed partitions, from the point of view of the code that encodes
 * and decodes one. A device with no key ring supplies nothing and carries everything opaque,
 * which is exactly what a relay is.
 */
export interface EventCrypto {
  /** The sealed form of this partition's payload, or `undefined` when it is not a sealed one. */
  readonly seal?: (
    partition: PartitionKey,
    plain: Uint8Array,
    aad: Uint8Array,
  ) => Uint8Array | undefined;
  /** The payload behind a seal, or `undefined` when this device holds no key for the partition. */
  readonly open?: (
    partition: PartitionKey,
    sealed: Uint8Array,
    aad: Uint8Array,
  ) => Uint8Array | undefined;
}

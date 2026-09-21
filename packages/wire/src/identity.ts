import type { PeerId } from "@syncmesh/kernel";

import { x25519 } from "@noble/curves/ed25519.js";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import { bytesToHex } from "./hex.js";
import { hostSigner } from "./signing.js";

ed.hashes.sha512 = sha512;

export class InvalidSeed extends TaggedError("InvalidSeed")<{ length: number; message: string }> {}

/** A device: its Ed25519 keypair. The public key is the peer id; the seed never leaves the device. */
export interface Identity {
  readonly peerId: PeerId;
  readonly publicKey: Uint8Array;
  readonly sign: (bytes: Uint8Array) => Uint8Array;
  /**
   * The shared secret between this device and an X25519 public key, for anything sealed *to* it
   * — a sealed partition's content key riding inside a grant (book ch. 14).
   *
   * The same keypair signs and agrees, on purpose: a device's peer id is its Ed25519 public key,
   * so anyone who can address it can already seal to it without a second key to publish, revoke
   * or get wrong. The seed still never leaves this closure; what goes out is one shared secret
   * for one sender's ephemeral key.
   */
  readonly agree: (theirPublicKey: Uint8Array) => Uint8Array;
}

export const SEED_LENGTH = 32;

export function createIdentity(seed: Uint8Array): Result<Identity, InvalidSeed> {
  if (seed.length !== SEED_LENGTH) {
    return Result.err(
      new InvalidSeed({ length: seed.length, message: `expected ${SEED_LENGTH} bytes` }),
    );
  }
  const publicKey = ed.getPublicKey(seed);
  const peerId = parsePeerId(bytesToHex(publicKey)).unwrap();
  return Result.ok({
    peerId,
    publicKey,
    sign: (bytes) => hostSigner()?.sign(bytes, seed) ?? ed.sign(bytes, seed),
    // the clamped scalar an Ed25519 seed already expands to, which is the X25519 secret for it
    agree: (theirPublicKey) =>
      x25519.getSharedSecret(ed.utils.getExtendedPublicKey(seed).head, theirPublicKey),
  });
}

/** Never throws: a malformed signature or key is simply not valid. */
export function verify(bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  return Result.try({
    try: () =>
      hostSigner()?.verify(bytes, signature, publicKey) ?? ed.verify(signature, bytes, publicKey),
    catch: () => false,
  }).unwrapOr(false);
}

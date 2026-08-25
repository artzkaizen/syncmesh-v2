import type { PeerId } from "@syncmesh/kernel";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import { bytesToHex } from "./hex.js";

ed.hashes.sha512 = sha512;

export class InvalidSeed extends TaggedError("InvalidSeed")<{ length: number; message: string }> {}

/** A device: its Ed25519 keypair. The public key is the peer id; the seed never leaves the device. */
export interface Identity {
  readonly peerId: PeerId;
  readonly publicKey: Uint8Array;
  readonly sign: (bytes: Uint8Array) => Uint8Array;
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
  return Result.ok({ peerId, publicKey, sign: (bytes) => ed.sign(bytes, seed) });
}

/** Never throws: a malformed signature or key is simply not valid. */
export function verify(bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  return Result.try({
    try: () => ed.verify(signature, bytes, publicKey),
    catch: () => false,
  }).unwrapOr(false);
}

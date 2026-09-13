import type { PeerId } from "@syncmesh/kernel";
import type { Identity } from "@syncmesh/wire";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { bytesToHex, verify } from "@syncmesh/wire";

/**
 * What a sniffer is allowed to learn from a link, and what it is not.
 *
 * Events carry their own signatures, so nothing here is what makes a write trustworthy — the
 * bridge would reject a forged one either way. What this adds is confidentiality: every medium
 * a device is reachable on is shared with strangers — a radio broadcasts to whoever is in the
 * room, an access point carries everyone's packets past everyone's network card — and without
 * this, every row a device syncs is readable by anybody standing in either place.
 *
 * One exchange for every medium, deliberately. A device that speaks BLE to the phone beside it
 * and Wi-Fi to the laptop across the room is not two security stories, and a per-medium
 * handshake would be two chances to get it wrong.
 *
 * Two frames, one per direction, crossing without waiting for each other: each end signs a
 * fresh X25519 public key with the Ed25519 key that *is* its peer id, and the two agree a
 * session key from the pair. Signing is what makes the exchange more than eavesdropper-proof —
 * an unsigned X25519 is a machine in the middle away from reading everything — and the key
 * being fresh per link is what stops a stolen device seeing yesterday's traffic.
 */

/** A signed offer of an ephemeral key. Both ends send one, unprompted, and neither waits. */
export const HELLO = 0x01;
/** A frame under the session key: nonce, then ciphertext and its tag. */
export const SEALED = 0x02;

const KEY_BYTES = 32;
const SIG_BYTES = 64;
const NONCE_BYTES = 24;

export const HELLO_BYTES = 1 + KEY_BYTES * 2 + SIG_BYTES;
/** What sealing costs on the wire: the kind, the nonce, and Poly1305's tag. */
export const SEAL_OVERHEAD = 1 + NONCE_BYTES + 16;

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * Domain separation. The signature says "this ephemeral key is mine, for a link session" and
 * cannot be lifted from anywhere else the same Ed25519 key signs — nor lifted out to stand in
 * for an event.
 */
const CONTEXT = utf8("syncmesh/link/hello/v1");
const INFO = utf8("syncmesh/link/session/v1");

export class HandshakeFailed extends TaggedError("HandshakeFailed")<{ message: string }> {}

/** A peer's opening frame, once its signature has been checked. */
export interface Hello {
  /** The frame as it travelled; both ends hash the pair, so the exact bytes matter. */
  readonly frame: Uint8Array;
  readonly peerId: PeerId;
  /** The Ed25519 key the signature was checked against, which is what the peer id is made of. */
  readonly publicKey: Uint8Array;
  /** This link's X25519 key, discarded when the link ends. */
  readonly ephemeral: Uint8Array;
}

/** One direction each: a key is used to seal or to open, never both. */
export interface SessionKeys {
  readonly seal: Uint8Array;
  readonly open: Uint8Array;
}

const signedBytes = (publicKey: Uint8Array, ephemeral: Uint8Array): Uint8Array => {
  const out = new Uint8Array(CONTEXT.length + KEY_BYTES * 2);
  out.set(CONTEXT, 0);
  out.set(publicKey, CONTEXT.length);
  out.set(ephemeral, CONTEXT.length + KEY_BYTES);
  return out;
};

/** A fresh X25519 secret, kept only as long as the link. */
export const ephemeralSecret = (): Uint8Array => x25519.utils.randomSecretKey();

/** A nonce for one frame. Injected in tests; there is nothing to derive it from otherwise. */
export const sealNonce = (): Uint8Array => randomBytes(NONCE_BYTES);

export function writeHello(identity: Identity, secret: Uint8Array): Hello {
  const ephemeral = x25519.getPublicKey(secret);
  const signature = identity.sign(signedBytes(identity.publicKey, ephemeral));
  const frame = new Uint8Array(HELLO_BYTES);
  frame[0] = HELLO;
  frame.set(identity.publicKey, 1);
  frame.set(ephemeral, 1 + KEY_BYTES);
  frame.set(signature, 1 + KEY_BYTES * 2);
  return { frame, peerId: identity.peerId, publicKey: identity.publicKey, ephemeral };
}

/** Never throws: a frame that is not a well-signed hello is simply not one. */
export function readHello(frame: Uint8Array): Result<Hello, HandshakeFailed> {
  const fail = (message: string) => Result.err(new HandshakeFailed({ message }));
  if (frame.length !== HELLO_BYTES || frame[0] !== HELLO)
    return fail(`expected a ${HELLO_BYTES}-byte hello, got ${frame.length} bytes`);
  const publicKey = frame.slice(1, 1 + KEY_BYTES);
  const ephemeral = frame.slice(1 + KEY_BYTES, 1 + KEY_BYTES * 2);
  const signature = frame.slice(1 + KEY_BYTES * 2);
  if (!verify(signedBytes(publicKey, ephemeral), signature, publicKey))
    return fail("the hello was not signed by the key it claims");
  return parsePeerId(bytesToHex(publicKey))
    .mapError(() => new HandshakeFailed({ message: "the hello carried no usable peer id" }))
    .map((peerId) => ({ frame, peerId, publicKey, ephemeral }));
}

/**
 * The session key, from our secret and the two hellos.
 *
 * Both ends compute the same thing from facts both hold, so there is nothing to negotiate and no
 * round trip to wait for. The transcript is the salt: a machine in the middle that swapped either
 * frame ends up with a different key from at least one side, and its traffic stops opening.
 *
 * The directions are separate keys, chosen by peer id order rather than by who dialled, so both
 * ends agree without asking and neither ever seals two frames under one nonce space.
 */
export function sessionKeys(
  secret: Uint8Array,
  self: Hello,
  peer: Hello,
): Result<SessionKeys, HandshakeFailed> {
  if (self.peerId === peer.peerId)
    return Result.err(new HandshakeFailed({ message: "the hello is our own, reflected back" }));
  const shared = Result.try({
    try: () => x25519.getSharedSecret(secret, peer.ephemeral),
    catch: () => new HandshakeFailed({ message: "the peer offered an unusable ephemeral key" }),
  });
  return shared.map((bytes) => {
    const first = self.peerId < peer.peerId;
    const transcript = new Uint8Array(HELLO_BYTES * 2);
    transcript.set(first ? self.frame : peer.frame, 0);
    transcript.set(first ? peer.frame : self.frame, HELLO_BYTES);
    const okm = hkdf(sha256, bytes, transcript, INFO, KEY_BYTES * 2);
    const lower = okm.slice(0, KEY_BYTES);
    const upper = okm.slice(KEY_BYTES);
    return first ? { seal: lower, open: upper } : { seal: upper, open: lower };
  });
}

/** A random nonce per frame: 24 bytes is wide enough that counting them buys nothing. */
export function seal(key: Uint8Array, plaintext: Uint8Array, nonce: Uint8Array): Uint8Array {
  const body = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const frame = new Uint8Array(1 + NONCE_BYTES + body.length);
  frame[0] = SEALED;
  frame.set(nonce, 1);
  frame.set(body, 1 + NONCE_BYTES);
  return frame;
}

/** Never throws: a frame that does not open under this key is one this link did not send. */
export function unseal(key: Uint8Array, frame: Uint8Array): Result<Uint8Array, HandshakeFailed> {
  if (frame.length < SEAL_OVERHEAD || frame[0] !== SEALED)
    return Result.err(new HandshakeFailed({ message: "not a sealed frame" }));
  return Result.try({
    try: () =>
      xchacha20poly1305(key, frame.slice(1, 1 + NONCE_BYTES)).decrypt(frame.slice(1 + NONCE_BYTES)),
    catch: () => new HandshakeFailed({ message: "the frame did not open under the session key" }),
  });
}

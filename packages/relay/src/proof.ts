import type { PeerId } from "@syncmesh/kernel";
import type { Identity } from "@syncmesh/wire";

import { hexToBytes, randomBytes, verify } from "@syncmesh/wire";

/**
 * A join proves the key it names (D33).
 *
 * Before this, a join was a bare peer id and the room believed it: anyone could take a device's
 * seat, be paged what was meant for it, and — because a newer join supersedes the older socket —
 * hang up on the real device from anywhere on the internet. The peer id *is* an Ed25519 public
 * key, so the fix is the one the link handshake already uses: sign something fresh with it.
 *
 * The room sends a challenge as the first frame on every socket; the join carries a signature
 * over that nonce and the join's own body. Fresh per socket, so a captured proof opens nothing
 * later; over the body, so a machine in the middle cannot re-cursor the join it forwards. Domain
 * separated, so the signature cannot be lifted from a link hello or an event, nor lifted out to
 * stand in for one.
 */
export const NONCE_BYTES = 32;

const CONTEXT = new TextEncoder().encode("syncmesh/relay/join/v2");

/** A fresh challenge for one socket. */
export const newChallenge = (): Uint8Array => randomBytes(NONCE_BYTES);

const signedBytes = (nonce: Uint8Array, core: Uint8Array): Uint8Array => {
  const out = new Uint8Array(CONTEXT.length + nonce.length + core.length);
  out.set(CONTEXT, 0);
  out.set(nonce, CONTEXT.length);
  out.set(core, CONTEXT.length + nonce.length);
  return out;
};

/** The proof a device puts on its join: its own key over the room's challenge and the join's core. */
export const proveJoin = (identity: Identity, nonce: Uint8Array, core: Uint8Array): Uint8Array =>
  identity.sign(signedBytes(nonce, core));

/** Never throws: a proof that does not verify against the key the join names is simply not one. */
export const verifyJoinProof = (
  peer: PeerId,
  nonce: Uint8Array,
  core: Uint8Array,
  proof: Uint8Array,
): boolean => {
  const key = hexToBytes(peer);
  return key.isOk() && verify(signedBytes(nonce, core), proof, key.value);
};

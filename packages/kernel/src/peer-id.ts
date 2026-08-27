import { Result, TaggedError } from "@syncmesh/result";

import type { Brand } from "./primitives.js";

/** A device identity: its Ed25519 public key as 64 lowercase hex characters. See RFC-0002. */
export type PeerId = Brand<string, "PeerId">;

export class InvalidPeerId extends TaggedError("InvalidPeerId")<{
  input: string;
  message: string;
}> {}

/**
 * Wire form of a {@link PeerId}: 64 lowercase hex characters. `AccountId` is the same shape and
 * reuses this rather than declaring a second copy of it — see D21, which also explains why the
 * two sharing one namespace means nothing may render a device as its own account.
 */
export const PEER_ID_HEX = /^[0-9a-f]{64}$/;

/** What both hex-id parsers say when the shape is wrong, so the two cannot drift apart. */
export const HEX_ID_EXPECTED = "expected 64 lowercase hex characters";

/**
 * Parses a peer id from its hex form.
 *
 * @param input Candidate hex string.
 * @returns The peer id, or `InvalidPeerId`.
 *
 * @example
 * parsePeerId("9da8…8b8b").isOk(); // true for 64 lowercase hex chars
 */
export function parsePeerId(input: string): Result<PeerId, InvalidPeerId> {
  if (!PEER_ID_HEX.test(input)) {
    return Result.err(new InvalidPeerId({ input, message: HEX_ID_EXPECTED }));
  }
  // SAFETY: matched PEER_ID_HEX, which is exactly the PeerId invariant
  return Result.ok(input as PeerId);
}

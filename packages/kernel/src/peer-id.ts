import { Result, TaggedError } from "@syncmesh/result";

import type { Brand } from "./brand.js";

/** A device identity: its Ed25519 public key as 64 lowercase hex characters. See RFC-0002. */
export type PeerId = Brand<string, "PeerId">;

/** The input was not 64 lowercase hex characters. */
export class InvalidPeerId extends TaggedError("InvalidPeerId")<{
  input: string;
  message: string;
}> {}

/** Wire form of a {@link PeerId}: 64 lowercase hex characters. */
export const PEER_ID_HEX = /^[0-9a-f]{64}$/;

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
    return Result.err(
      new InvalidPeerId({ input, message: "expected 64 lowercase hex characters" }),
    );
  }
  // SAFETY: matched PEER_ID_HEX, which is exactly the PeerId invariant
  return Result.ok(input as PeerId);
}

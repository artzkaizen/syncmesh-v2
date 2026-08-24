import { Result, TaggedError } from "@syncmesh/result";

/** A device identity: its Ed25519 public key as 64 lowercase hex characters. See RFC-0002. */
export type PeerId = string & { readonly __brand: "PeerId" };

/** The input was not 64 lowercase hex characters. */
export class InvalidPeerId extends TaggedError("InvalidPeerId")<{
  input: string;
  message: string;
}> {}

const HEX_64 = /^[0-9a-f]{64}$/;

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
  if (!HEX_64.test(input)) {
    return Result.err(
      new InvalidPeerId({ input, message: "expected 64 lowercase hex characters" }),
    );
  }
  // SAFETY: matched HEX_64, which is exactly the PeerId invariant
  return Result.ok(input as PeerId);
}

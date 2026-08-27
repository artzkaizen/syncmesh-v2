import { Result, TaggedError } from "@syncmesh/result";

import type { Brand } from "./primitives.js";

import { HEX_ID_EXPECTED, PEER_ID_HEX } from "./peer-id.js";

/**
 * An account: its Ed25519 public key as 64 lowercase hex characters. The id **is** the
 * verification key, so a link core names its own verifier and nothing has to vouch for the
 * binding. Free-form ids would not: anyone could mint a key and sign "I am `acct_ada`" to take
 * every row whose owner column holds that string (D21).
 *
 * It shares the 64-hex namespace {@link PeerId} occupies, which is why nothing may render a
 * device id as an account id — the two would be indistinguishable to an `allow` rule.
 */
export type AccountId = Brand<string, "AccountId">;

export class InvalidAccountId extends TaggedError("InvalidAccountId")<{
  input: string;
  message: string;
}> {}

/**
 * Parses an account id from its hex form.
 *
 * @param input Candidate hex string.
 * @returns The account id, or `InvalidAccountId`.
 *
 * @example
 * parseAccountId(bytesToHex(accountPublicKey)).isOk(); // true
 */
export function parseAccountId(input: string): Result<AccountId, InvalidAccountId> {
  if (!PEER_ID_HEX.test(input)) {
    return Result.err(new InvalidAccountId({ input, message: HEX_ID_EXPECTED }));
  }
  // SAFETY: matched PEER_ID_HEX, which is exactly the AccountId invariant
  return Result.ok(input as AccountId);
}

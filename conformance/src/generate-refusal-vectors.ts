/**
 * Regenerates conformance/refusal-vectors.json from fixed seeds. Run only when the refusal wire
 * deliberately changes (README rule 3): `bun conformance/src/generate-refusal-vectors.ts`.
 *
 * The refusing twin of a custody receipt (D32): the same envelope, signed by the peer that parked
 * the event, under the same seeds as the receipt vectors so the two read side by side.
 */
import type { QuarantineReason } from "@syncmesh/wire";

import { parseSeqNum } from "@syncmesh/kernel";
import { bytesToHex, createIdentity, issueRefusal } from "@syncmesh/wire";

import { AUTHOR_SEED, HOLDER_SEED, NOW } from "./generate-receipt-vectors.js";

export function refusalVectors() {
  const refuser = createIdentity(HOLDER_SEED).unwrap();
  const author = createIdentity(AUTHOR_SEED).unwrap();
  const cases = [
    { description: "the ladder said no: no grant", seq: 1, reason: "refused", verdict: "NoGrant" },
    {
      description: "the ladder said no: policy, deep in the log",
      seq: 4096,
      reason: "refused",
      verdict: "PolicyDenied",
    },
    {
      description: "an older build: a table it has no definition for",
      seq: 7,
      reason: "unknown-table",
      verdict: "UnknownTable",
    },
    {
      description: "an older build: a change kind it cannot apply",
      seq: 8,
      reason: "unknown-kind",
      verdict: "UnknownChangeKind",
    },
  ] satisfies readonly {
    description: string;
    seq: number;
    reason: QuarantineReason;
    verdict: string;
  }[];
  return {
    refuserId: refuser.peerId,
    authorId: author.peerId,
    vectors: cases.map(({ description, seq, reason, verdict }) => ({
      description,
      seq,
      reason,
      verdict,
      wireHex: bytesToHex(
        issueRefusal(refuser, {
          author: author.peerId,
          seq: parseSeqNum(seq).unwrap(),
          reason,
          verdict,
          now: NOW,
        }),
      ),
    })),
  };
}

if (import.meta.main) {
  const out = new URL("../refusal-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(refusalVectors(), null, 2)}\n`);
}

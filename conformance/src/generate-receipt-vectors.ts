/**
 * Regenerates conformance/receipt-vectors.json from fixed seeds. Run only when the custody wire
 * deliberately changes (README rule 3): `bun conformance/src/generate-receipt-vectors.ts`.
 *
 * Frozen now rather than when it was written, because until D28 nothing sent one: the codec
 * existed, no device supplied an incarnation, and a receipt that reaches no ledger is not a wire
 * anybody can diverge from. It is one now — a vouch is what licenses a destructive action — so
 * the bytes stop being this build's business.
 */
import type { SeqNum } from "@syncmesh/kernel";

import { Temporal } from "@syncmesh/temporal";
import { bytesToHex, createIdentity, issueReceipt } from "@syncmesh/wire";

const HOLDER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 21 + i);
const AUTHOR_SEED = Uint8Array.from({ length: 32 }, (_, i) => 121 + i);
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

export function receiptVectors() {
  const holder = createIdentity(HOLDER_SEED).unwrap();
  const author = createIdentity(AUTHOR_SEED).unwrap();
  const base = { author: author.peerId, incarnation: "store-1", now: NOW } as const;
  /* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- a sequence is a branded integer, and these are the documented literals */
  const cases = [
    {
      description: "custody of one event",
      request: { ...base, throughSeq: 1 as SeqNum },
    },
    {
      description: "a contiguous run — custody covers everything at or below the sequence",
      request: { ...base, throughSeq: 4096 as SeqNum },
    },
    {
      description: "a second lineage of the same holder: same peer, different store",
      request: { ...base, incarnation: "store-2", throughSeq: 4096 as SeqNum },
    },
  ];
  /* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
  return {
    holderId: holder.peerId,
    authorId: author.peerId,
    vectors: cases.map(({ description, request }) => ({
      description,
      wireHex: bytesToHex(issueReceipt(holder, request)),
    })),
  };
}

if (import.meta.main) {
  const out = new URL("../receipt-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(receiptVectors(), null, 2)}\n`);
}

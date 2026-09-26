import type { PeerId } from "@syncmesh/kernel";
/**
 * Regenerates conformance/checkpoint-vectors.json from fixed seeds. Run only when the checkpoint
 * certificate deliberately changes (README rule 3): `bun conformance/src/generate-checkpoint-vectors.ts`.
 *
 * A checkpoint is what lets a snapshot stop being provisional (book ch. 4): the authority signs
 * the hash of the rows and the coverage they stand for. The rows are frozen beside the
 * certificate so a port can reproduce the hash and not only check the signature.
 */
import type { CheckpointRow } from "@syncmesh/wire";

import { parsePartitionKey } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { bytesToHex, checkpointHash, createIdentity, issueCheckpoint } from "@syncmesh/wire";

const ISSUER_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const AUTHOR_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 + i);
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const ROWS: readonly CheckpointRow[] = [
  { table: "notes", key: "n2", record: Uint8Array.of(0xa1, 0x00, 0x01) },
  { table: "notes", key: "n1", record: Uint8Array.of(0xa1, 0x00, 0x02) },
  { table: "tags", key: "t1", record: Uint8Array.of(0xa0) },
];

export function checkpointVectors() {
  const issuer = createIdentity(ISSUER_SEED).unwrap();
  const author = createIdentity(AUTHOR_SEED).unwrap();
  const stateHash = checkpointHash(ROWS);
  const coverage = new Map<PeerId, number>([[author.peerId, 42]]);
  const cases = [
    {
      description: "the issuer's whole state",
      request: { stateHash, coverage, now: NOW },
    },
    {
      description: "one partition",
      request: { partition: parsePartitionKey("org:acme").unwrap(), stateHash, coverage, now: NOW },
    },
  ];
  return {
    issuerId: issuer.peerId,
    authorId: author.peerId,
    rows: ROWS.map((row) => ({
      table: row.table,
      key: row.key,
      recordHex: bytesToHex(row.record),
    })),
    stateHashHex: bytesToHex(stateHash),
    vectors: cases.map(({ description, request }) => ({
      description,
      wireHex: bytesToHex(issueCheckpoint(issuer, request)),
    })),
  };
}

if (import.meta.main) {
  const out = new URL("../checkpoint-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(checkpointVectors(), null, 2)}\n`);
}

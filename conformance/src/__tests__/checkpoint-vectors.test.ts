import type { PeerId } from "@syncmesh/kernel";

import { bytesToHex, checkpointHash, hexToBytes, verifyCheckpoint } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../checkpoint-vectors.json" with { type: "json" };
import { checkpointVectors } from "../generate-checkpoint-vectors.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the frozen file holds real peer ids as hex */
const ISSUER = raw.issuerId as PeerId;
const AUTHOR = raw.authorId as PeerId;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const rows = raw.rows.map((row) => ({
  table: row.table,
  key: row.key,
  record: hexToBytes(row.recordHex).unwrap(),
}));

describe("checkpoint certificate vectors — frozen", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(checkpointVectors()))).toEqual(raw);
  });

  test("the state hash is reproducible from the rows, in any order", () => {
    expect(bytesToHex(checkpointHash(rows))).toBe(raw.stateHashHex);
    expect(bytesToHex(checkpointHash([...rows].reverse()))).toBe(raw.stateHashHex);
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const wire = hexToBytes(v.wireHex).unwrap();
      const certificate = verifyCheckpoint(wire, ISSUER, rows).unwrap();
      expect(String(certificate.issuer)).toBe(raw.issuerId);
      expect(bytesToHex(certificate.stateHash)).toBe(raw.stateHashHex);
      expect(certificate.coverage.get(AUTHOR)).toBe(42);
      // a row altered is a mismatch; a certificate under another issuer is not a certificate
      const altered = rows.map((row, i) =>
        i === 0 ? { ...row, record: Uint8Array.of(0xa0) } : row,
      );
      const mismatch = verifyCheckpoint(wire, ISSUER, altered);
      expect(mismatch.isErr() && mismatch.error._tag).toBe("CheckpointMismatch");
      const forged = verifyCheckpoint(wire, AUTHOR, rows);
      expect(forged.isErr() && forged.error._tag).toBe("BadCheckpointSignature");
    });
  }
});

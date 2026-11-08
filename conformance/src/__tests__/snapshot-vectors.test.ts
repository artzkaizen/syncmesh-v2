import { decodeFrame } from "@syncmesh/transport";
import { decodeSnapshotRows, encodeSnapshotRows, hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../snapshot-vectors.json" with { type: "json" };
import { snapshotVectors } from "../generate-snapshot-vectors.js";

describe("join exchange vectors — frozen (RFC-0019, D46, U31)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the exchange, change the vectors — deliberately)", async () => {
    expect(JSON.parse(JSON.stringify(await snapshotVectors()))).toEqual(raw);
  });

  test("every served page decodes and re-encodes to the bytes that were sent", () => {
    for (const { frames } of Object.values(raw.served)) {
      for (const hex of frames) {
        const frame = decodeFrame(hexToBytes(hex).unwrap()).unwrap();
        if (frame.kind !== "snap-chunk") continue;
        const rows = decodeSnapshotRows(frame.bytes).unwrap();
        expect(encodeSnapshotRows(rows)).toEqual(frame.bytes);
      }
    }
  });

  test("the cases cover each row of D46's adoption table", () => {
    const vouched = raw.joins.filter((j) => j.settled?.vouched === true);
    const unasked = raw.joins.filter((j) => j.settled === null);
    expect(vouched).toHaveLength(2);
    expect(unasked.map((j) => j.synced)).toEqual([[], []]);
  });
});

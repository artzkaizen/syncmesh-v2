import { decodeFrame } from "@syncmesh/transport";
import { decodeSnapshotRows, encodeSnapshotRows, hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../snapshot-vectors.json" with { type: "json" };
import { snapshotVectors } from "../generate-snapshot-vectors.js";

describe("join exchange vectors — frozen (RFC-0019, D46, U31)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the exchange, change the vectors — deliberately)", async () => {
    expect(JSON.parse(JSON.stringify(await snapshotVectors()))).toEqual(raw);
  });

  /** The pages a set of frames carries, re-encoded from what they decode to. */
  const reencoded = (frames: readonly string[]) =>
    frames.flatMap((hex) => {
      const frame = decodeFrame(hexToBytes(hex).unwrap()).unwrap();
      if (frame.kind !== "snap-chunk") return [];
      return [
        { sent: frame.bytes, again: encodeSnapshotRows(decodeSnapshotRows(frame.bytes).unwrap()) },
      ];
    });

  test("every served page decodes and re-encodes to the bytes that were sent", () => {
    const { legacy: _older, ...current } = raw.served;
    for (const { frames } of Object.values(current))
      for (const { sent, again } of reencoded(frames)) expect(again).toEqual(sent);
  });

  test("a page from a holder before U34 re-encodes with its cells in column order", () => {
    const legacy = reencoded(raw.served.legacy.frames);
    const unsorted = reencoded(raw.served.unsorted.frames);
    expect(legacy.map(({ sent }) => sent)).not.toEqual(unsorted.map(({ sent }) => sent));
    expect(legacy.map(({ again }) => again)).toEqual(unsorted.map(({ sent }) => sent));
  });

  test("a holder leaves its local table out: it serves the frames of one that never wrote it (U36)", () => {
    expect(raw.served.local).toEqual(raw.served.everything);
  });

  test("an install's floor is what the log keeps for a rebuild to refuse on (U37)", () => {
    for (const join of raw.joins) expect(join.installed).toEqual(join.floor);
  });

  test("the cases cover each row of D46's adoption table", () => {
    const vouched = raw.joins.filter((j) => j.settled?.vouched === true);
    const unasked = raw.joins.filter((j) => j.settled === null);
    expect(vouched).toHaveLength(3);
    expect(unasked.map((j) => j.synced)).toEqual([[], []]);
  });
});

import { parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { decodeCbor, encodeCbor } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import {
  cursorsFrame,
  decodeFrame,
  digestFrame,
  eventFrame,
  grantFrame,
  grantRequestFrame,
} from "../frame.js";

const A = parsePeerId("a".repeat(64)).unwrap();
const B = parsePeerId("b".repeat(64)).unwrap();
const seq = (n: number) => parseSeqNum(n).unwrap();

describe("the frame codec", () => {
  test("a compaction floor rides at index 4, with ahead always before it (D46)", () => {
    const cursors = new Map([[A, seq(9)]]);
    const floor = new Map([[A, seq(5)]]);
    const bytes = cursorsFrame(B, cursors, undefined, floor);
    expect(decodeFrame(bytes).unwrap()).toEqual({
      kind: "cursors",
      from: B,
      cursors,
      ahead: new Map(),
      floor,
    });
    // what an older build reads: the first four elements, so the frame still counts as cursors
    const older = decodeCbor(bytes).unwrap();
    expect(Array.isArray(older) && older.length).toBe(5);
    const prefix = Array.isArray(older) ? encodeCbor(older.slice(0, 4)) : bytes;
    expect(decodeFrame(prefix).unwrap()).toEqual({
      kind: "cursors",
      from: B,
      cursors,
      ahead: new Map(),
    });
    // and a floor that is not a list of cursor pairs is refused, not read as no floor
    const bad = Array.isArray(older) ? encodeCbor([...older.slice(0, 4), "nope"]) : bytes;
    expect(decodeFrame(bad).isErr()).toBe(true);
  });

  test("all four kinds round-trip", () => {
    const bytes = Uint8Array.of(1, 2, 3);
    expect(decodeFrame(grantFrame(bytes)).unwrap()).toEqual({ kind: "grant", wire: bytes });
    expect(decodeFrame(eventFrame(bytes)).unwrap()).toEqual({ kind: "event", wire: bytes });
    expect(decodeFrame(grantRequestFrame(A)).unwrap()).toEqual({
      kind: "grant-request",
      peerId: A,
    });
    expect(decodeFrame(grantRequestFrame(A, "inv-7")).unwrap()).toEqual({
      kind: "grant-request",
      peerId: A,
      invite: "inv-7",
    });
    const cursors = new Map([
      [A, seq(3)],
      [B, seq(9)],
    ]);
    expect(decodeFrame(cursorsFrame(A, cursors)).unwrap()).toEqual({
      kind: "cursors",
      from: A,
      cursors,
    });
  });

  test("both halves of a position travel, and an older frame's silence stays silence", () => {
    const cursors = new Map([[A, seq(3)]]);
    const ahead = new Map([[B, [seq(9), seq(11)]]]);
    expect(decodeFrame(cursorsFrame(A, cursors, ahead)).unwrap()).toEqual({
      kind: "cursors",
      from: A,
      cursors,
      ahead,
    });
    const digests = new Map([["notes", 7n]]);
    expect(decodeFrame(digestFrame("s", cursors, digests, ahead)).unwrap()).toEqual({
      kind: "digest",
      scope: "s",
      at: cursors,
      digests,
      ahead,
    });
    // an empty `ahead` is a claim ("nothing above my cursor"); an absent one is not
    expect(decodeFrame(cursorsFrame(A, cursors, new Map())).unwrap()).toHaveProperty(
      "ahead",
      new Map(),
    );
    expect(decodeFrame(cursorsFrame(A, cursors)).unwrap()).not.toHaveProperty("ahead");
    expect(decodeFrame(digestFrame("s", cursors, digests)).unwrap()).not.toHaveProperty("ahead");
  });

  test("garbage and unknown tags are values, never throws", () => {
    expect(decodeFrame(Uint8Array.of(0xff, 0x00)).isErr()).toBe(true);
    expect(decodeFrame(encodeCbor([99, "future"])).unwrap()).toEqual({ kind: "unknown" });
    expect(decodeFrame(encodeCbor([0, "not-bytes"])).isErr()).toBe(true);
  });
});

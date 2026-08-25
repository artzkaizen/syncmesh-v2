import { parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { encodeCbor } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { cursorsFrame, decodeFrame, eventFrame, grantFrame, grantRequestFrame } from "../frame.js";

const A = parsePeerId("a".repeat(64)).unwrap();
const B = parsePeerId("b".repeat(64)).unwrap();
const seq = (n: number) => parseSeqNum(n).unwrap();

describe("the frame codec", () => {
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

  test("garbage and unknown tags are values, never throws", () => {
    expect(decodeFrame(Uint8Array.of(0xff, 0x00)).isErr()).toBe(true);
    expect(decodeFrame(encodeCbor([99, "future"])).unwrap()).toEqual({ kind: "unknown" });
    expect(decodeFrame(encodeCbor([0, "not-bytes"])).isErr()).toBe(true);
  });
});

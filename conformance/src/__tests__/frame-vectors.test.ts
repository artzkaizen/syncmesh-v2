import { KIND, LENGTH_BYTES, decodeFrame } from "@syncmesh/transport";
import { bytesToHex, hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../frame-vectors.json" with { type: "json" };
import { frameVectors } from "../generate-frame-vectors.js";

describe("session frame vectors — frozen", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(frameVectors()))).toEqual(raw);
  });

  test("the tag space is the one the vector pins", () => {
    const tags = new Set(raw.vectors.map((v) => v.tag));
    expect([...tags].sort((a, b) => a - b)).toEqual(Object.values(KIND).sort((a, b) => a - b));
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const wire = hexToBytes(v.wireHex).unwrap();
      // the tag is the second byte, under a one-byte array header: readable without a decode,
      // which is what lets a forwarding session class a frame it never opens
      expect((wire[0] ?? 0) & 0xe0).toBe(0x80);
      expect(wire[1]).toBe(v.tag);
      const decoded = decodeFrame(wire).unwrap();
      expect(String(decoded.kind)).toBe(v.kind);
    });
  }

  test("length framing: four big-endian bytes, then the frame, nothing else", () => {
    const frame = hexToBytes(raw.framing.example.frameHex).unwrap();
    const framed = hexToBytes(raw.framing.example.framedHex).unwrap();
    expect(raw.framing.lengthBytes).toBe(LENGTH_BYTES);
    expect(framed).toHaveLength(LENGTH_BYTES + frame.length);
    expect(new DataView(framed.buffer).getUint32(0)).toBe(frame.length);
    expect(bytesToHex(framed.slice(LENGTH_BYTES))).toBe(raw.framing.example.frameHex);
  });
});

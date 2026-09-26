import { HEADER_BYTES, fragment, reassembler } from "@syncmesh/ble";
import { bytesToHex, hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../fragment-vectors.json" with { type: "json" };
import { fragmentVectors } from "../generate-fragment-vectors.js";

const header = (packet: Uint8Array) => {
  const view = new DataView(packet.buffer, packet.byteOffset, HEADER_BYTES);
  return { message: view.getUint32(0), index: view.getUint16(4), total: view.getUint16(6) };
};

describe("BLE fragment vectors — frozen", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(fragmentVectors()))).toEqual(raw);
  });

  test("the header is eight bytes", () => {
    expect(raw.headerBytes).toBe(HEADER_BYTES);
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const frame = hexToBytes(v.frameHex).unwrap();
      const parts = v.fragmentsHex.map((h) => hexToBytes(h).unwrap());
      expect(fragment(frame, v.limit, v.message).unwrap().map(bytesToHex)).toEqual(v.fragmentsHex);
      // every fragment names the message, its place and the count, and fits the write
      parts.forEach((packet, i) => {
        expect(packet.length).toBeLessThanOrEqual(v.limit);
        expect(header(packet)).toEqual({ message: v.message, index: i, total: parts.length });
      });
      // and they go back together in any order — here, backwards
      const back = reassembler();
      const out = [...parts].reverse().map((packet) => back.accept(packet));
      expect(out.slice(0, -1).every((f) => f === undefined)).toBe(true);
      expect(bytesToHex(out[out.length - 1] ?? new Uint8Array(1))).toBe(v.frameHex);
      expect(back.pending()).toBe(0);
    });
  }

  for (const r of raw.refusals) {
    test(r.description, () => {
      const refused = fragment(new Uint8Array(r.frameBytes), r.limit, 1);
      expect(String(refused.isErr() && refused.error._tag)).toBe(r.error);
    });
  }
});

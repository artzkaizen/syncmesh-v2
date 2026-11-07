import { bytesToHex, decodeCbor, encodeRefusal, hexToBytes, verifyRefusal } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../refusal-vectors.json" with { type: "json" };
import { refusalVectors } from "../generate-refusal-vectors.js";

describe("refusal receipt vectors — frozen (D32)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(refusalVectors()))).toEqual(raw);
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const wire = hexToBytes(v.wireHex).unwrap();
      const refusal = verifyRefusal(wire).unwrap();
      expect(String(refusal.refuser)).toBe(raw.refuserId);
      expect(String(refusal.author)).toBe(raw.authorId);
      expect(Number(refusal.seq)).toBe(v.seq);
      expect<string>(refusal.reason).toBe(v.reason);
      expect(refusal.verdict).toBe(v.verdict);
      // re-encoding the decoded refusal reproduces the signed core byte for byte: the reason
      // and the verdict are inside the signature rather than beside it
      const outer = decodeCbor(wire).unwrap();
      if (!Array.isArray(outer) || !(outer[0] instanceof Uint8Array)) throw new Error("fixture");
      expect(bytesToHex(encodeRefusal(refusal))).toBe(bytesToHex(outer[0]));
    });
  }
});

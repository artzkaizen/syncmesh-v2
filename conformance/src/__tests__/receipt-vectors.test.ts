import { bytesToHex, decodeCbor, encodeReceipt, hexToBytes, verifyReceipt } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../receipt-vectors.json" with { type: "json" };
import { receiptVectors } from "../generate-receipt-vectors.js";

describe("custody receipt vectors — frozen", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(receiptVectors()))).toEqual(raw);
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const wire = hexToBytes(v.wireHex).unwrap();
      const receipt = verifyReceipt(wire).unwrap();
      expect(String(receipt.holder)).toBe(raw.holderId);
      expect(String(receipt.author)).toBe(raw.authorId);
      // re-encoding the decoded receipt reproduces the signed core byte for byte, so the
      // incarnation is inside the signature rather than beside it
      const outer = decodeCbor(wire).unwrap();
      if (!Array.isArray(outer) || !(outer[0] instanceof Uint8Array)) throw new Error("fixture");
      expect(bytesToHex(encodeReceipt(receipt))).toBe(bytesToHex(outer[0]));
    });
  }
});

import { parseAccountId, parsePeerId } from "@syncmesh/kernel";
import {
  bytesToHex,
  encodeAccountCore,
  hexToBytes,
  splitEnvelope,
  verifyLink,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../account-vectors.json" with { type: "json" };
import { accountVectors } from "../generate-account-vectors.js";

describe("account link vectors — frozen", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(accountVectors()))).toEqual(raw);
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const wire = hexToBytes(v.wireHex).unwrap();
      const link = verifyLink(wire).unwrap();
      expect(String(link.account)).toBe(parseAccountId(raw.accountId).unwrap());
      expect(String(link.device)).toBe(parsePeerId(raw.deviceId).unwrap());
      expect(bytesToHex(encodeAccountCore(link))).toBe(
        bytesToHex(splitEnvelope(wire).unwrap().core),
      );
    });
  }
});

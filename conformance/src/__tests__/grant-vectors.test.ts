import { parsePeerId } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { bytesToHex, decodeCbor, encodeGrant, hexToBytes, verifyGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../grant-vectors.json" with { type: "json" };
import { grantVectors } from "../generate-grant-vectors.js";

const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

describe("grant vectors — frozen", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(grantVectors()))).toEqual(raw);
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const wire = hexToBytes(v.wireHex).unwrap();
      const grant = verifyGrant(wire, parsePeerId(raw.issuerId).unwrap(), NOW).unwrap();
      expect(String(grant.device)).toBe(raw.deviceId);
      const outer = decodeCbor(wire).unwrap();
      if (!Array.isArray(outer) || !(outer[0] instanceof Uint8Array)) throw new Error("fixture");
      expect(bytesToHex(encodeGrant(grant))).toBe(bytesToHex(outer[0]));
    });
  }
});

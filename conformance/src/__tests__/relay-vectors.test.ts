import { RELAY_PROTOCOL_VERSIONS, decodeRelayFrame } from "@syncmesh/relay";
import { decodeCbor, hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../relay-vectors.json" with { type: "json" };
import { relayVectors } from "../generate-relay-vectors.js";

describe("relay control frame vectors — frozen (D14, D33)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(relayVectors()))).toEqual(raw);
  });

  test("this build speaks the versions the file says", () => {
    expect([...RELAY_PROTOCOL_VERSIONS]).toEqual(raw.protocolVersions);
  });

  test("the control tags run 8 through 19 with no gaps, above the session tags", () => {
    const tags = [...new Set(raw.vectors.map((v) => v.tag))].sort((a, b) => a - b);
    expect(tags).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const wire = hexToBytes(v.wireHex).unwrap();
      const parts = decodeCbor(wire).unwrap();
      expect(Array.isArray(parts) && parts[0]).toBe(v.tag);
      expect(String(decodeRelayFrame(wire).unwrap().kind)).toBe(v.kind);
    });
  }
});

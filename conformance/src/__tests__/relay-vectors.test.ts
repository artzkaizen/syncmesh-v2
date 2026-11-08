import { scopeFrom } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { RELAY_PROTOCOL_VERSIONS, decodeRelayFrame } from "@syncmesh/relay";
import { bytesToHex, decodeCbor, hexToBytes, verifyRefusal } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import refusals from "../../refusal-vectors.json" with { type: "json" };
import raw from "../../relay-vectors.json" with { type: "json" };
import { relayVectors } from "../generate-relay-vectors.js";

const ACME = parsePartitionKey("org:acme").unwrap();

describe("relay control frame vectors — frozen (D14, D33)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(relayVectors()))).toEqual(raw);
  });

  test("this build speaks the versions the file says", () => {
    expect([...RELAY_PROTOCOL_VERSIONS]).toEqual(raw.protocolVersions);
  });

  test("the control tags run 8 through 22 with no gaps, above the session tags", () => {
    const tags = [...new Set(raw.vectors.map((v) => v.tag))].sort((a, b) => a - b);
    expect(tags).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  });

  test("a refusal crosses a relay as the refusal vector's own signed wire, under tag 22 (D32)", () => {
    const [vector] = raw.vectors.filter((v) => v.kind === "refusal");
    const frame = decodeRelayFrame(hexToBytes(vector?.wireHex ?? "").unwrap()).unwrap();
    const wire = frame.kind === "refusal" ? frame.wire : new Uint8Array();
    expect(bytesToHex(wire)).toBe(refusals.vectors[0]?.wireHex ?? "?");
    expect(verifyRefusal(wire).unwrap().verdict).toBe("NoGrant");
  });

  test("a blob-put without a partition decodes as before, and with one carries it (D18)", () => {
    const puts = raw.vectors
      .filter((v) => v.kind === "blob-put")
      .map((v) => decodeRelayFrame(hexToBytes(v.wireHex).unwrap()).unwrap());
    const partitions = puts.map((f) => (f.kind === "blob-put" ? f.partition : undefined));
    expect(partitions).toEqual([undefined, ACME]);
  });

  test("a blob-refused names its code, the limit, the spend, and the partition when there is one", () => {
    const refusals = raw.vectors
      .filter((v) => v.kind === "blob-refused")
      .map((v) => decodeRelayFrame(hexToBytes(v.wireHex).unwrap()).unwrap());
    expect(refusals).toEqual([
      {
        kind: "blob-refused",
        hash: "b3:0102",
        code: "quota",
        limit: 1024,
        used: 1000,
        partition: ACME,
      },
      { kind: "blob-refused", hash: "b3:0102", code: "quota", limit: 1024, used: 1000 },
    ]);
  });

  test("a gated catch-up's scope reads back as the interest and the entitlement it names (D24)", () => {
    const scoped = raw.vectors
      .filter((v) => v.description.includes("(D24)"))
      .map((v) => decodeRelayFrame(hexToBytes(v.wireHex).unwrap()).unwrap())
      .map((frame) => (frame.kind === "page" ? scopeFrom(frame.scoped?.scope) : undefined));
    // compared as text: a partition key is a brand, and the vector file holds plain strings
    expect(JSON.stringify(scoped)).toBe(
      JSON.stringify([
        { interest: { partitions: ["org:acme"] }, entitlement: "clinics:a" },
        { entitlement: "clinics:a" },
      ]),
    );
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

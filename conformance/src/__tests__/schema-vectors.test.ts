import { decodeFrame } from "@syncmesh/transport";
import {
  bytesToHex,
  decodeAndVerify,
  encodeCbor,
  encodeEventCore,
  hexToBytes,
  verifyRefusal,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../schema-vectors.json" with { type: "json" };
import { schemaVectors } from "../generate-schema-vectors.js";

describe("schema evolution vectors — frozen (D31)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(schemaVectors()))).toEqual(raw);
  });

  for (const v of raw.events) {
    test(`event: ${v.description}`, () => {
      const core = hexToBytes(v.coreHex).unwrap();
      const wire = encodeCbor([core, hexToBytes(v.sigHex).unwrap()]);
      // never a gate: every one of them verifies and decodes, whatever key 9 holds
      const { event } = decodeAndVerify(wire).unwrap();
      expect(String(event.peerId)).toBe(raw.peerId);
      expect<number | null>(event.schemaVersion ?? null).toBe(v.schemaVersion);
      expect(event.changes).toHaveLength(1);
      expect(bytesToHex(encodeEventCore(event)) === v.coreHex).toBe(v.reencodes);
    });
  }

  for (const v of raw.frames) {
    test(`frame: ${v.description}`, () => {
      const frame = decodeFrame(hexToBytes(v.wireHex).unwrap()).unwrap();
      if (frame.kind !== "cursors") throw new Error(`expected cursors, got ${frame.kind}`);
      expect(String(frame.from)).toBe(raw.peerId);
      expect(frame.cursors.size).toBe(2);
      expect<number | null>(frame.schemaVersion ?? null).toBe(v.schemaVersion);
      // index 3 is always there for index 5 to follow: empty when there was nothing above
      expect((frame.ahead?.size ?? 0) > 0).toBe(v.ahead);
    });
  }

  for (const v of raw.refusals) {
    test(`refusal: ${v.description}`, () => {
      const refusal = verifyRefusal(hexToBytes(v.wireHex).unwrap()).unwrap();
      expect(String(refusal.refuser)).toBe(raw.refuserId);
      expect(String(refusal.author)).toBe(raw.authorId);
      expect<string>(refusal.reason).toBe(v.reason);
      expect(refusal.verdict).toBe(v.verdict);
    });
  }
});

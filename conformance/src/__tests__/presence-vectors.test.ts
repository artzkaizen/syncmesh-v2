import {
  bytesToHex,
  decodeAndVerifyPresence,
  decodePresenceCore,
  hexToBytes,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../presence-vectors.json" with { type: "json" };
import { presenceVectors } from "../generate-presence-vectors.js";

describe("presence vectors — frozen (D16)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(presenceVectors()))).toEqual(raw);
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const verified = decodeAndVerifyPresence(hexToBytes(v.wireHex).unwrap()).unwrap();
      const { presence } = verified;
      expect(String(presence.peerId)).toBe(raw.peerId);
      expect(presence.topic).toBe(v.topic);
      expect(String(presence.partition)).toBe(v.partition);
      expect(presence.session).toBe(v.session);
      expect(presence.count).toBe(v.count);
      expect(presence.expires).toBe(v.expires);
      // the core alone decodes to the same value, and is the bytes the signature covers
      expect(decodePresenceCore(hexToBytes(v.coreHex).unwrap()).unwrap()).toEqual(presence);
      expect(bytesToHex(verified.wire)).toBe(v.wireHex);
      // a bit flipped in the core is not the author's any more
      const wire = hexToBytes(v.wireHex).unwrap();
      wire[wire.length - 70] = (wire[wire.length - 70] ?? 0) ^ 1;
      expect(decodeAndVerifyPresence(wire).isErr()).toBe(true);
    });
  }

  test("a cursor carries a row and a departure carries null", () => {
    const [cursor, departure] = raw.vectors.map((v) =>
      decodePresenceCore(hexToBytes(v.coreHex).unwrap()).unwrap(),
    );
    expect(cursor?.value instanceof Map && [...cursor.value.entries()]).toEqual([
      ["x", 12],
      ["y", 34],
    ]);
    expect(departure?.value).toBeNull();
  });
});

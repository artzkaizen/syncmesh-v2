import { decodeRelayFrame, verifyJoinProof } from "@syncmesh/relay";
import { bytesToHex, hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../join-vectors.json" with { type: "json" };
import { joinVectors } from "../generate-join-vectors.js";

describe("relay join proof vectors — frozen (D33)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(joinVectors()))).toEqual(raw);
  });

  test("the challenge frame is tag 19 over the nonce", () => {
    const decoded = decodeRelayFrame(hexToBytes(raw.challengeHex).unwrap()).unwrap();
    expect(decoded.kind).toBe("challenge");
    expect(decoded.kind === "challenge" && bytesToHex(decoded.nonce)).toBe(raw.nonceHex);
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const decoded = decodeRelayFrame(hexToBytes(v.joinHex).unwrap()).unwrap();
      if (decoded.kind !== "join") throw new Error("expected a join");
      // the room recomputes the core from what it decoded and lands on the sender's bytes
      expect(bytesToHex(decoded.core)).toBe(v.coreHex);
      expect(decoded.proof && bytesToHex(decoded.proof)).toBe(v.proofHex);
      expect(String(decoded.peerId)).toBe(raw.deviceId);
      const nonce = hexToBytes(raw.nonceHex).unwrap();
      expect(verifyJoinProof(decoded.peerId, nonce, decoded.core, decoded.proof!)).toBe(true);
      // and not against a different challenge, nor a different body
      expect(
        verifyJoinProof(decoded.peerId, new Uint8Array(32), decoded.core, decoded.proof!),
      ).toBe(false);
      expect(verifyJoinProof(decoded.peerId, nonce, decoded.core.slice(1), decoded.proof!)).toBe(
        false,
      );
    });
  }
});

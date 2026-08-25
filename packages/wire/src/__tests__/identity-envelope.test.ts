import { describe, expect, test } from "bun:test";

import { decodeAndVerify, signEvent } from "../envelope.js";
import { bytesEqual, bytesToHex, hexToBytes } from "../hex.js";
import { createIdentity, SEED_LENGTH, verify } from "../identity.js";
import { event, IDENTITY_A, IDENTITY_B, key, row, SEED_A, table } from "./fixtures.js";

describe("identity", () => {
  test("a seed yields a stable peer id (the hex public key) and signatures that verify", () => {
    const again = createIdentity(SEED_A).unwrap();
    expect(again.peerId).toBe(IDENTITY_A.peerId);
    expect(bytesToHex(again.publicKey)).toBe(String(IDENTITY_A.peerId));
    const msg = new TextEncoder().encode("hello");
    const sig = IDENTITY_A.sign(msg);
    expect(sig).toHaveLength(64);
    expect(verify(msg, sig, IDENTITY_A.publicKey)).toBe(true);
    expect(verify(msg, sig, IDENTITY_B.publicKey)).toBe(false);
    expect(verify(new TextEncoder().encode("hellO"), sig, IDENTITY_A.publicKey)).toBe(false);
  });

  test("a wrong-length seed, a garbage signature or key are values / false, never throws", () => {
    expect(createIdentity(new Uint8Array(SEED_LENGTH - 1)).isErr()).toBe(true);
    expect(verify(new Uint8Array(3), new Uint8Array(5), new Uint8Array(7))).toBe(false);
  });
});

describe("envelope", () => {
  const e = event([
    { kind: "insert", table: table("notes"), key: key("k1"), row: row({ title: "t" }) },
  ]);

  test("signEvent → decodeAndVerify round-trips and hands back the exact received bytes", () => {
    const signed = signEvent(e, IDENTITY_A);
    const verified = decodeAndVerify(signed.wire).unwrap();
    expect(verified.event.id).toBe(e.id);
    expect(bytesEqual(verified.core, signed.core)).toBe(true);
    expect(bytesEqual(verified.wire, signed.wire)).toBe(true);
  });

  test("a flipped bit in the core is BadSignature; a swapped author is BadSignature", () => {
    const signed = signEvent(e, IDENTITY_A);
    const tampered = Uint8Array.from(signed.wire);
    const last = tampered.length - 70;
    tampered[last] = (tampered[last] ?? 0) ^ 0x01;
    const r = decodeAndVerify(tampered);
    expect(r.isErr() && r.error._tag).toBe("BadSignature");
    const forged = signEvent(e, IDENTITY_B);
    expect(decodeAndVerify(forged.wire).isErr()).toBe(true);
  });

  test("garbage frames are typed errors, never throws", () => {
    for (const bad of ["", "00", "80", "82", "820101", "8240", "824041", "8241ff41ff"]) {
      const r = decodeAndVerify(hexToBytes(bad).unwrap());
      expect(r.isErr()).toBe(true);
    }
  });
});

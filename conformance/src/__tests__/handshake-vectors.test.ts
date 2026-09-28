import { HELLO_BYTES, readHello, seal, sessionKeys, unseal } from "@syncmesh/transport";
import { bytesToHex, hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../handshake-vectors.json" with { type: "json" };
import { handshakeVectors } from "../generate-handshake-vectors.js";

const bytes = (hex: string) => hexToBytes(hex).unwrap();

describe("link handshake vectors — frozen", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(handshakeVectors()))).toEqual(raw);
  });

  test("each hello is well-signed by the key that is its peer id", () => {
    const a = readHello(bytes(raw.helloAHex)).unwrap();
    const b = readHello(bytes(raw.helloBHex)).unwrap();
    expect(String(a.peerId)).toBe(raw.aId);
    expect(String(b.peerId)).toBe(raw.bId);
    expect(a.frame).toHaveLength(HELLO_BYTES);
  });

  test("both ends derive the same session keys from the two hellos, crossed", () => {
    const a = readHello(bytes(raw.helloAHex)).unwrap();
    const b = readHello(bytes(raw.helloBHex)).unwrap();
    const keysA = sessionKeys(bytes(raw.aSecretHex), a, b).unwrap();
    const keysB = sessionKeys(bytes(raw.bSecretHex), b, a).unwrap();
    expect(bytesToHex(keysA.seal)).toBe(raw.aSealKeyHex);
    expect(bytesToHex(keysB.seal)).toBe(raw.bSealKeyHex);
    expect(bytesToHex(keysA.open)).toBe(raw.bSealKeyHex);
    expect(bytesToHex(keysB.open)).toBe(raw.aSealKeyHex);
  });

  test("the sealed frame is reproducible from key, nonce and plaintext, and opens at the far end", () => {
    const sealed = seal(bytes(raw.aSealKeyHex), bytes(raw.plaintextHex), bytes(raw.nonceHex));
    expect(bytesToHex(sealed)).toBe(raw.sealedByAHex);
    const opened = unseal(bytes(raw.aSealKeyHex), bytes(raw.sealedByAHex)).unwrap();
    expect(bytesToHex(opened)).toBe(raw.plaintextHex);
    // and not under the other direction's key
    expect(unseal(bytes(raw.bSealKeyHex), bytes(raw.sealedByAHex)).isErr()).toBe(true);
  });

  test("a hello with one byte changed is not a hello", () => {
    const tampered = bytes(raw.helloAHex);
    tampered[HELLO_BYTES - 1] = (tampered[HELLO_BYTES - 1] ?? 0) ^ 0x01;
    expect(readHello(tampered).isErr()).toBe(true);
  });
});

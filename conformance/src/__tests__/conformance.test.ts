import { bytesToHex, decodeCbor, encodeCbor, hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { checkVector, type WireCodec } from "../harness.js";
import { wireVectors } from "../vectors.js";

describe("the oracle is wired", () => {
  test("the frozen file is loaded and well-formed", () => {
    expect(wireVectors.vectors.length).toBeGreaterThan(0);
    expect(hexToBytes(wireVectors.peerId).unwrap()).toHaveLength(32);
    for (const v of wireVectors.vectors) {
      expect(hexToBytes(v.sigHex).unwrap()).toHaveLength(64);
      expect(hexToBytes(v.coreHex).unwrap()[0]).toBe(0xa6);
      expect(v.coreHex).toContain(wireVectors.peerId);
    }
  });

  test("an empty codec fails every vector for the right reason", () => {
    const empty: WireCodec<undefined> = {
      decodeCore: () => undefined,
      encodeCore: () => new Uint8Array(),
      verify: () => false,
    };
    for (const v of wireVectors.vectors) {
      const verdict = checkVector(empty, v);
      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.reason).toStartWith("re-encoded core differs");
    }
  });

  test("the canonical CBOR layer already reproduces every vector's core byte-for-byte", () => {
    for (const v of wireVectors.vectors) {
      const core = hexToBytes(v.coreHex).unwrap();
      expect(bytesToHex(encodeCbor(decodeCbor(core).unwrap()))).toBe(v.coreHex);
    }
  });
});

describe("wire vectors", () => {
  // E03 tasks 3–5 replace `undefined` with the real codec.
  const codec: WireCodec<never> | undefined = undefined;
  for (const v of wireVectors.vectors) {
    if (codec === undefined) test.todo(v.description, () => {});
    else test(v.description, () => expect(checkVector(codec, v)).toEqual({ ok: true }));
  }
});

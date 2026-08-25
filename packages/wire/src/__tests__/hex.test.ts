import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { bytesEqual, bytesToHex, hexToBytes } from "../hex.js";

describe("hex", () => {
  test("round-trips and rejects bad input as a value", () => {
    expect(bytesToHex(hexToBytes("00ff10").unwrap())).toBe("00ff10");
    expect(hexToBytes("").unwrap()).toHaveLength(0);
    for (const bad of ["0", "0G", "FF", "zz"]) expect(hexToBytes(bad).isErr()).toBe(true);
  });

  test("property: bytes → hex → bytes is identity", () => {
    fc.assert(
      fc.property(fc.uint8Array(), (bytes) => {
        expect(bytesEqual(hexToBytes(bytesToHex(bytes)).unwrap(), bytes)).toBe(true);
      }),
    );
  });
});

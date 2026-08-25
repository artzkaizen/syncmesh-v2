import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { decodeCbor } from "../cbor-decode.js";
import { compareKeys, encodeCbor, type CborKey, type CborValue } from "../cbor.js";
import { bytesEqual, bytesToHex, hexToBytes } from "../hex.js";

const hex = (v: CborValue) => bytesToHex(encodeCbor(v));

describe("canonical encoding — the frozen rules", () => {
  test("shortest-form heads", () => {
    expect(hex(0)).toBe("00");
    expect(hex(23)).toBe("17");
    expect(hex(24)).toBe("1818");
    expect(hex(255)).toBe("18ff");
    expect(hex(256)).toBe("190100");
    expect(hex(65_536)).toBe("1a00010000");
    expect(hex(4_294_967_296)).toBe("1b0000000100000000");
    expect(hex(-1)).toBe("20");
    expect(hex(-25)).toBe("3818");
  });

  test("safe integers are ints, everything else is f64 — 1.0 is the int 1", () => {
    expect(hex(1)).toBe("01");
    expect(hex(1.0)).toBe("01");
    expect(hex(1.5)).toBe("fb3ff8000000000000");
    expect(hex(Number.MAX_SAFE_INTEGER + 2)).toStartWith("fb");
  });

  test("null and absent are different bytes", () => {
    expect(hex(new Map([[0, null]]))).toBe("a100f6");
    expect(hex(new Map())).toBe("a0");
  });

  test("map keys: integers ascending, then strings by their bytes — pinned before title", () => {
    const m = new Map<CborKey, CborValue>([
      ["title", 1],
      [7, 2],
      ["pinned", 3],
      [0, 4],
      ["body", 5],
    ]);
    expect([...new Map([...m].sort(([a], [b]) => compareKeys(a, b))).keys()]).toEqual([
      0,
      7,
      "body",
      "pinned",
      "title",
    ]);
    expect(hex(m)).toBe(
      "a5" + "0004" + "0702" + "64626f647905" + "6670696e6e656403" + "657469746c6501",
    );
  });

  test("simple values, text, bytes, arrays", () => {
    expect(hex(true)).toBe("f5");
    expect(hex(false)).toBe("f4");
    expect(hex(null)).toBe("f6");
    expect(hex("")).toBe("60");
    expect(hex("héllo ✨")).toBe("6a68c3a96c6c6f20e29ca8");
    expect(hex(Uint8Array.of(1, 2))).toBe("420102");
    expect(hex([1, "a", []])).toBe("8301616180");
  });
});

describe("decoding", () => {
  test("malformed, truncated and trailing bytes are values, not throws", () => {
    for (const bad of [
      "",
      "18",
      "5820ab",
      "a1",
      "a100",
      "fb00",
      "0100",
      "c0",
      "5f",
      "3b0000000000000000ff",
    ]) {
      expect(decodeCbor(hexToBytes(bad).unwrap()).isErr()).toBe(true);
    }
    expect(decodeCbor(hexToBytes("63ffffff").unwrap()).isErr()).toBe(true);
  });
});

const arbKey: fc.Arbitrary<CborKey> = fc.oneof(fc.nat({ max: 1_000 }), fc.string({ maxLength: 8 }));
const arbValue: fc.Arbitrary<CborValue> = fc.letrec<{ v: CborValue }>((tie) => ({
  v: fc.oneof(
    { depthSize: "small" },
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.double({ noNaN: true, noDefaultInfinity: true }).filter((d) => !Number.isSafeInteger(d)),
    fc.string({ maxLength: 12 }),
    fc.boolean(),
    fc.constant(null),
    fc.uint8Array({ maxLength: 16 }),
    fc.array(tie("v"), { maxLength: 4 }),
    fc
      .uniqueArray(fc.tuple(arbKey, tie("v")), { maxLength: 4, selector: ([k]) => k })
      .map((es) => new Map(es)),
  ),
})).v;

describe("properties", () => {
  test("decode ∘ encode ≡ id, and re-encoding is byte-identical", () => {
    fc.assert(
      fc.property(arbValue, (value) => {
        const bytes = encodeCbor(value);
        const decoded = decodeCbor(bytes).unwrap();
        expect(bytesEqual(encodeCbor(decoded), bytes)).toBe(true);
        expect(decoded).toEqual(value);
      }),
      { numRuns: 1_000 },
    );
  });
});

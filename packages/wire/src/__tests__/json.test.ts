import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { CborKey, CborValue } from "../cbor.js";

import { encodeCbor } from "../cbor.js";
import { bytesToHex } from "../hex.js";
import { deserialize, fromJson, negotiate, serialize, toJson } from "../json.js";

/** Every shape a CborValue can take, nested a few levels deep. */
const key: fc.Arbitrary<CborKey> = fc.oneof(fc.string(), fc.integer({ min: -1000, max: 1000 }));
const value: fc.Arbitrary<CborValue> = fc.letrec<{ value: CborValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: false }),
    fc.uint8Array().map((bytes) => Uint8Array.from(bytes)),
    fc.array(tie("value"), { maxLength: 4 }),
    fc
      .uniqueArray(fc.tuple(key, tie("value")), { maxLength: 4, selector: ([k]) => k })
      .map((pairs) => new Map(pairs)),
  ),
})).value;

describe("toJson / fromJson — a lossless projection", () => {
  test("bytes, non-finite numbers and mixed keys are boxed under `$`; everything else is itself", () => {
    expect(toJson(new Map<CborKey, CborValue>([["a", 1]]))).toEqual({ a: 1 });
    expect(toJson(Uint8Array.from([0xde, 0xad]))).toEqual({ $hex: "dead" });
    expect(toJson(Number.NaN)).toEqual({ $num: "NaN" });
    expect(toJson(Number.NEGATIVE_INFINITY)).toEqual({ $num: "-Infinity" });
    expect(toJson(new Map<CborKey, CborValue>([[7, "seven"]]))).toEqual({ $map: [[7, "seven"]] });
    // a string key that spells a box is boxed too, so `{ "$hex": "…" }` can only ever mean bytes
    expect(toJson(new Map<CborKey, CborValue>([["$hex", "text"]]))).toEqual({
      $map: [["$hex", "text"]],
    });
    // keys come out in the wire's order: integers ascending, then strings by their bytes
    // SAFETY: a string-keyed map projects to a plain object, whose keys are what is under test
    expect(
      Object.keys(
        toJson(
          new Map<CborKey, CborValue>([
            ["b", 1],
            ["a", 2],
          ]),
        ) as object,
      ),
    ).toEqual(["a", "b"]);
  });

  test("the round trip is the identity on the wire's bytes, for every value", () => {
    fc.assert(
      fc.property(value, (v) => {
        // SAFETY: a stringified projection parses back to JSON, which is what `fromJson` takes
        const back = fromJson(JSON.parse(JSON.stringify(toJson(v))) as never).unwrap();
        expect(bytesToHex(encodeCbor(back))).toBe(bytesToHex(encodeCbor(v)));
      }),
      { numRuns: 300 },
    );
  });

  test("a box with the wrong inside is refused by path, never guessed at", () => {
    const bad = fromJson({ rows: [{ $hex: "zz" }] });
    expect(bad.isErr()).toBe(true);
    const failure = bad.match({ ok: () => undefined, err: (e) => e });
    expect(failure?._tag).toBe("MalformedJson");
    expect(failure?.path).toBe("$.rows[0].$hex");
    expect(fromJson({ $num: "seven" }).isErr()).toBe(true);
    // SAFETY: a boolean key is exactly the malformed shape under test
    expect(fromJson({ $map: [[true, 1]] } as never).isErr()).toBe(true);
  });
});

describe("negotiate — JSON unless CBOR was asked for", () => {
  test("nothing, */* and a browser's Accept all read JSON; application/cbor reads the bytes", () => {
    expect(negotiate(null)).toBe("application/json");
    expect(negotiate("*/*")).toBe("application/json");
    expect(negotiate("text/html,application/xhtml+xml,*/*;q=0.8")).toBe("application/json");
    expect(negotiate("application/cbor")).toBe("application/cbor");
    expect(negotiate("application/json;q=0.5, application/cbor")).toBe("application/cbor");
    expect(negotiate("application/cbor;q=0.1, application/json")).toBe("application/json");
  });

  test("serialize and deserialize agree with the negotiated media", () => {
    const v: CborValue = new Map<CborKey, CborValue>([
      ["room", "issues"],
      ["key", Uint8Array.from([1, 2])],
    ]);
    for (const media of ["application/cbor", "application/json"] as const) {
      const bytes = serialize(v, media);
      expect(bytesToHex(encodeCbor(deserialize(bytes, media).unwrap()))).toBe(
        bytesToHex(encodeCbor(v)),
      );
    }
    expect(new TextDecoder().decode(serialize(v, "application/json"))).toBe(
      '{"key":{"$hex":"0102"},"room":"issues"}',
    );
    expect(deserialize(new TextEncoder().encode("{nope"), "application/json").isErr()).toBe(true);
  });
});

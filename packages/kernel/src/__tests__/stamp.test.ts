import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { Hlc, Logical } from "../hlc.js";

import { parsePeerId, type PeerId } from "../peer-id.js";
import { compareStamp, type Stamp } from "../stamp.js";

const A = parsePeerId("a".repeat(64)).unwrap();
const B = parsePeerId("b".repeat(64)).unwrap();

const hlc = (ms: number, l: number): Hlc => {
  // SAFETY: test fixture; l is always a small non-negative integer
  return [Temporal.Instant.fromEpochMilliseconds(ms), l as Logical];
};
const stamp = (ms: number, l: number, peer: PeerId): Stamp => ({ hlc: hlc(ms, l), peer });

describe("parsePeerId", () => {
  test("accepts 64 lowercase hex characters", () => {
    const r = parsePeerId("9da891814f903cea173bc809a9abd1048a798caca6c591b5d843933d60898b8b");
    expect(r.isOk()).toBe(true);
  });

  test("rejects wrong length, uppercase and non-hex as a value", () => {
    for (const bad of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)]) {
      const r = parsePeerId(bad);
      expect(r.isErr() && r.error._tag).toBe("InvalidPeerId");
    }
  });
});

describe("compareStamp", () => {
  test("orders by hlc first", () => {
    expect(compareStamp(stamp(1, 9, B), stamp(2, 0, A))).toBe(-1);
    expect(compareStamp(stamp(2, 0, A), stamp(1, 9, B))).toBe(1);
    expect(compareStamp(stamp(1, 0, B), stamp(1, 1, A))).toBe(-1);
  });

  test("same hlc → peer id breaks the tie", () => {
    expect(compareStamp(stamp(1, 0, A), stamp(1, 0, B))).toBe(-1);
    expect(compareStamp(stamp(1, 0, B), stamp(1, 0, A))).toBe(1);
  });

  test("equal stamps compare exactly 0 — never -1 or 1", () => {
    expect(compareStamp(stamp(5, 3, A), stamp(5, 3, A))).toBe(0);
    expect(compareStamp(stamp(5, 3, A), stamp(5, 4, A))).toBe(-1);
    expect(compareStamp(stamp(5, 3, A), stamp(5, 3, B))).toBe(-1);
  });

  test("property: antisymmetric, transitive, and 0 only for equal stamps", () => {
    const hex = fc.stringMatching(/^[0-9a-f]{64}$/);
    const arb = fc
      .tuple(fc.nat({ max: 1_000 }), fc.nat({ max: 3 }), hex)
      .map(([ms, l, p]) => stamp(ms, l, parsePeerId(p).unwrap()));
    fc.assert(
      fc.property(arb, arb, arb, (x, y, z) => {
        expect(compareStamp(x, y) + compareStamp(y, x)).toBe(0);
        if (compareStamp(x, y) <= 0 && compareStamp(y, z) <= 0) {
          expect(compareStamp(x, z)).toBeLessThanOrEqual(0);
        }
        const equal = x.hlc[0].equals(y.hlc[0]) && x.hlc[1] === y.hlc[1] && x.peer === y.peer;
        expect(compareStamp(x, y) === 0).toBe(equal);
      }),
    );
  });
});

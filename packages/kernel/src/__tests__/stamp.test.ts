import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { PEER_ID_HEX, parsePeerId } from "../peer-id.js";
import { compareStamp } from "../stamp.js";
import { PEER_A, PEER_B, stamp } from "./fixtures.js";

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
    expect(compareStamp(stamp(1, 9, PEER_B), stamp(2, 0, PEER_A))).toBe(-1);
    expect(compareStamp(stamp(2, 0, PEER_A), stamp(1, 9, PEER_B))).toBe(1);
    expect(compareStamp(stamp(1, 0, PEER_B), stamp(1, 1, PEER_A))).toBe(-1);
  });

  test("same hlc → peer id breaks the tie", () => {
    expect(compareStamp(stamp(1, 0, PEER_A), stamp(1, 0, PEER_B))).toBe(-1);
    expect(compareStamp(stamp(1, 0, PEER_B), stamp(1, 0, PEER_A))).toBe(1);
  });

  test("equal stamps compare exactly 0 — never -1 or 1", () => {
    expect(compareStamp(stamp(5, 3, PEER_A), stamp(5, 3, PEER_A))).toBe(0);
    expect(compareStamp(stamp(5, 3, PEER_A), stamp(5, 4, PEER_A))).toBe(-1);
    expect(compareStamp(stamp(5, 3, PEER_A), stamp(5, 3, PEER_B))).toBe(-1);
  });

  test("property: antisymmetric, transitive, and 0 only for equal stamps", () => {
    const hex = fc.stringMatching(PEER_ID_HEX);
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

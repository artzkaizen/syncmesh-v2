import { decodeRelayFrame } from "@syncmesh/relay";
import { WINDOW_TAGS, decodeWindowFrame, rowsFrame } from "@syncmesh/window";
import { decodeCbor, hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../window-vectors.json" with { type: "json" };
import { windowVectors } from "../generate-window-vectors.js";

describe("window frame vectors — frozen (D43, E24)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(windowVectors()))).toEqual(raw);
  });

  test("the tags are the ones this build speaks, clear of the relay's 8–19", () => {
    expect(raw.tags).toEqual({ ...WINDOW_TAGS });
    for (const tag of Object.values(raw.tags)) expect(tag).toBeGreaterThan(19);
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const wire = hexToBytes(v.wireHex).unwrap();
      const parts = decodeCbor(wire).unwrap();
      expect(Array.isArray(parts) && parts[0]).toBe(v.tag);
      const frame = decodeWindowFrame(wire).unwrap();
      expect(frame).toMatchObject({ kind: v.kind });
      // re-encoding a decoded patch lands on the frozen bytes: the codec is canonical
      if (frame?.kind === "rows") expect(rowsFrame(frame)).toEqual(wire);
    });

    test(`${v.description} — a relay build that predates it reads unknown (D14)`, () => {
      const wire = hexToBytes(v.wireHex).unwrap();
      expect(decodeRelayFrame(wire).unwrap().kind).toBe("unknown");
    });
  }
});

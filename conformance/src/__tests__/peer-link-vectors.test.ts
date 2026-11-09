import { decodeFrame } from "@syncmesh/transport";
import { hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../peer-link-vectors.json" with { type: "json" };
import { peerLinkVectors } from "../generate-peer-link-vectors.js";

const kinds = (frames: readonly string[]) =>
  frames.map((hex) => decodeFrame(hexToBytes(hex).unwrap()).unwrap().kind);

describe("peer session vectors — frozen (gap U3's radios)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the session, change the vectors — deliberately)", async () => {
    expect(JSON.parse(JSON.stringify(await peerLinkVectors()))).toEqual(raw);
  });

  test("a session opens with its cursors, and answers every cursors frame with a digest", () => {
    for (const answer of raw.answers) {
      expect(kinds(answer.open)).toEqual(["cursors"]);
      expect(kinds(answer.sent)).toContain("digest");
    }
  });

  test("an event past a hole is held until the hole is filled", () => {
    const held = raw.receives.find((r) => r.steps[0]?.index === 1);
    expect(held?.steps.map((s) => s.sent.length)).toEqual([0, 0, 1]);
  });
});

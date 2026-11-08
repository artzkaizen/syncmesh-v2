import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { belowPeerFloor } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import raw from "../../rejoin-vectors.json" with { type: "json" };
import { rejoinVectors } from "../generate-rejoin-vectors.js";

// SAFETY: the frozen file holds validated peer ids and positive sequence numbers
const cursors = (pairs: readonly (readonly (string | number)[])[]) =>
  new Map(pairs.map(([peer, seq]) => [peer as PeerId, seq as SeqNum]));

describe("rejoin vectors — frozen (D46)", () => {
  test("the generator still produces the frozen file (change the rule, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(rejoinVectors()))).toEqual(raw);
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      // SAFETY: the frozen file's own id
      const self = raw.self as PeerId;
      const below = belowPeerFloor(self, cursors(v.ours), cursors(v.theirs), cursors(v.floor));
      expect([...below]).toEqual([...cursors(v.below)]);
    });
  }
});

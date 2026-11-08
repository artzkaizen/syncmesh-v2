/**
 * Regenerates conformance/rejoin-vectors.json. Run only when the rule deliberately changes (README
 * rule 3): `bun conformance/src/generate-rejoin-vectors.ts`.
 *
 * Which of a peer's compaction floors a device is below (D46): given this device's own id, its
 * contiguous cursors, the peer's cursors and the floor the peer sent at index 4 of its cursors
 * frame, the authors and floors that send it asking for state. Both runtimes run the same rule.
 */
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { belowPeerFloor } from "@syncmesh/transport";

type Pairs = readonly (readonly [string, number])[];

// SAFETY: fixed 32-byte lowercase hex, which is all a peer id is
const id = (byte: string) => byte.repeat(32) as PeerId;
const SELF = id("11");
const A = id("aa");
const B = id("bb");

// SAFETY: every number written below is a positive integer, which is all a sequence number is
const cursors = (pairs: Pairs) =>
  new Map(pairs.map(([peer, seq]) => [peer as PeerId, seq as SeqNum]));

const cases: readonly {
  readonly description: string;
  readonly ours: Pairs;
  readonly theirs: Pairs;
  readonly floor: Pairs;
}[] = [
  {
    description: "below one author's floor",
    ours: [[A, 1]],
    theirs: [[A, 9]],
    floor: [[A, 5]],
  },
  {
    description: "exactly at the floor is not below: everything removed is already held",
    ours: [[A, 5]],
    theirs: [[A, 9]],
    floor: [[A, 5]],
  },
  {
    description: "an author this device holds nothing of is below any floor",
    ours: [],
    theirs: [[A, 9]],
    floor: [[A, 2]],
  },
  {
    description: "a floor above the sender's own cursor is ignored",
    ours: [],
    theirs: [[A, 3]],
    floor: [[A, 5]],
  },
  {
    description: "a frame with no cursors, a repage's, ignores every floor",
    ours: [],
    theirs: [],
    floor: [[A, 5]],
  },
  {
    description: "this device's own author is never a reason to ask for state",
    ours: [],
    theirs: [[SELF, 9]],
    floor: [[SELF, 5]],
  },
  {
    description: "two authors, one below, in the floor's order",
    ours: [
      [A, 7],
      [B, 1],
    ],
    theirs: [
      [B, 4],
      [A, 9],
    ],
    floor: [
      [B, 3],
      [A, 6],
    ],
  },
];

export function rejoinVectors() {
  return {
    self: SELF,
    vectors: cases.map(({ description, ours, theirs, floor }) => ({
      description,
      ours,
      theirs,
      floor,
      below: [...belowPeerFloor(SELF, cursors(ours), cursors(theirs), cursors(floor))],
    })),
  };
}

if (import.meta.main) {
  const out = new URL("../rejoin-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(rejoinVectors(), null, 2)}\n`);
}

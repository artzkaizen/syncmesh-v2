import { Temporal } from "@syncmesh/temporal";

import type { Hlc, Logical } from "../hlc.js";
import type { Stamp } from "../stamp.js";

import { parsePeerId, type PeerId } from "../peer-id.js";

export const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);

export const hlc = (ms: number, l: number): Hlc => {
  // SAFETY: test fixture; l is always a small non-negative integer
  return [at(ms), l as Logical];
};

export const stamp = (ms: number, l: number, peer: PeerId): Stamp => ({ hlc: hlc(ms, l), peer });

/** `[ms, logical]` view of an Hlc for `toEqual`. */
export const plain = ([physical, logical]: Hlc): [number, number] => [
  physical.epochMilliseconds,
  logical,
];

export const PEER_A = parsePeerId("a".repeat(64)).unwrap();
export const PEER_B = parsePeerId("b".repeat(64)).unwrap();

/** A settable wall clock for `createHlcClock`. */
export const fakeClock = (start: number) => {
  let ms = start;
  return {
    now: () => at(ms),
    set: (next: number) => {
      ms = next;
    },
  };
};

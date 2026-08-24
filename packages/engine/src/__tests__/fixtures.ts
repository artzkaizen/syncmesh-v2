import { createHlcClock, parsePeerId } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";

import type { Procedure } from "../event.js";

export const PEER_A = parsePeerId("a".repeat(64)).unwrap();
export const PEER_B = parsePeerId("b".repeat(64)).unwrap();

export const procedure = (label: string): Procedure => {
  // SAFETY: test fixture; procedure naming rules arrive with the client (E09)
  return label as Procedure;
};

export const hlcAt = (ms: number) =>
  createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms) }).tick();

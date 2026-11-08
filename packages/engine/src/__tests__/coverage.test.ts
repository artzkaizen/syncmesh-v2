import type { SeqNum } from "@syncmesh/kernel";

import { PEER_A } from "@syncmesh/kernel/test-fixtures";
import { describe, expect, test } from "bun:test";

import { trackCoverage } from "../coverage.js";

// SAFETY: test fixture sequence numbers
const at = (n: number) => n as SeqNum;
const run = (from: number, to: number) => ({
  peer: PEER_A,
  local: false,
  from: at(from),
  to: at(to),
});

describe("taking back a claim on a torn run (D39)", () => {
  test("the cursor drops below the run, what is held above it stays held, and filling it closes the run", () => {
    const tracker = trackCoverage({ synced: new Map([[PEER_A, at(6)]]), local: new Map() });
    tracker.reopen(run(3, 4));
    expect(tracker.current().synced.get(PEER_A)).toBe(at(2));
    expect(tracker.ahead().get(PEER_A)).toEqual([at(5), at(6)]);
    tracker.note({ peerId: PEER_A, seqNum: at(3) });
    expect(tracker.current().synced.get(PEER_A)).toBe(at(3));
    tracker.note({ peerId: PEER_A, seqNum: at(4) });
    expect(tracker.current().synced.get(PEER_A)).toBe(at(6));
    expect(tracker.ahead().get(PEER_A)).toBeUndefined();
  });

  test("a run from the first event leaves no cursor, and a run above the cursor moves nothing", () => {
    const tracker = trackCoverage({ synced: new Map([[PEER_A, at(2)]]), local: new Map() });
    tracker.reopen(run(5, 7));
    expect(tracker.current().synced.get(PEER_A)).toBe(at(2));
    tracker.reopen(run(1, 1));
    expect(tracker.current().synced.has(PEER_A)).toBe(false);
    expect(tracker.ahead().get(PEER_A)).toEqual([at(2)]);
  });
});

import type { SeqNum } from "@syncmesh/kernel";

import { PEER_A } from "@syncmesh/kernel/test-fixtures";
import { describe, expect, test } from "bun:test";

import { trackCoverage } from "../coverage.js";
import { heldRuns } from "../sync.js";

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

describe("the held run beside a scoped cursor (D32)", () => {
  const SCOPE = "org:acme";
  const scoped = (seq: number) => ({
    synced: new Map([[PEER_A, at(seq)]]),
    local: new Map(),
    scope: SCOPE,
  });

  test("a scoped adopt raises the cursor and not the held run; folding raises both", () => {
    const tracker = trackCoverage();
    tracker.note({ peerId: PEER_A, seqNum: at(1) });
    tracker.adopt(scoped(3));
    expect(tracker.current().synced.get(PEER_A)).toBe(at(3));
    expect(tracker.current().held?.get(PEER_A)).toBe(at(1));
    expect(heldRuns(tracker.current()).get(PEER_A)).toBe(at(1));
    tracker.note({ peerId: PEER_A, seqNum: at(3) });
    tracker.note({ peerId: PEER_A, seqNum: at(2) });
    expect(tracker.current().held?.get(PEER_A)).toBe(at(3));
  });

  test("an unscoped adopt raises both and drops the held run from the coverage", () => {
    const tracker = trackCoverage();
    tracker.adopt(scoped(3));
    tracker.adopt({ synced: new Map([[PEER_A, at(4)]]), local: new Map() });
    expect(tracker.current().held).toBeUndefined();
    tracker.adopt(scoped(6));
    expect(tracker.current().held?.get(PEER_A)).toBe(at(4));
  });

  test("a torn run lowers the held run too", () => {
    const tracker = trackCoverage();
    for (const n of [1, 2, 3]) tracker.note({ peerId: PEER_A, seqNum: at(n) });
    tracker.adopt(scoped(3));
    tracker.reopen(run(2, 2));
    expect(tracker.current().held?.get(PEER_A)).toBe(at(1));
  });

  test("a scoped coverage boots from its held run, never from its cursors", () => {
    expect(trackCoverage(scoped(5)).current().held?.has(PEER_A)).toBe(false);
    const persisted = { ...scoped(5), held: new Map([[PEER_A, at(2)]]) };
    expect(trackCoverage(persisted).current().held?.get(PEER_A)).toBe(at(2));
    const unscoped = { synced: new Map([[PEER_A, at(5)]]), local: new Map() };
    expect(heldRuns(trackCoverage(unscoped).current()).get(PEER_A)).toBe(at(5));
  });
});

import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";

import { fleetGreeting } from "../fan-in.js";
import { decodeRelayFrame } from "../frame-decode.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const author = (n: number) => n.toString(16).padStart(64, "0") as PeerId;
const seq = (n: number) => n as SeqNum;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const greeted = (frame: Uint8Array) => {
  const decoded = decodeRelayFrame(frame).unwrap();
  if (decoded.kind !== "hello") throw new Error(`expected a hello, got ${decoded.kind}`);
  return decoded;
};

describe("fleetGreeting (gaps U41)", () => {
  const cursors = new Map(Array.from({ length: 300 }, (_, i) => [author(i + 1), seq(i + 1)]));
  const base = { version: 4, keepaliveMs: 15_000, epoch: "e", cursors };

  test("names every author when the fan-out sets no limit", () => {
    expect(greeted(fleetGreeting(base)).cursors).toEqual(cursors);
  });

  test("fits the fan-out's frame, keeping the authors furthest along", () => {
    const frame = fleetGreeting({ ...base, maxFrame: 4000 });
    expect(frame.length).toBeLessThanOrEqual(4000);
    const named = greeted(frame).cursors;
    expect(named.size).toBeGreaterThan(50);
    expect(named.size).toBeLessThan(300);
    // the furthest ones, so what is left out is the cheapest to send again from the start
    const lowest = Math.min(...named.values());
    expect([...cursors.values()].filter((s) => s >= lowest)).toHaveLength(named.size);
    for (const [peer, at] of named) expect(cursors.get(peer)).toBe(at);
  });

  test("carries no floor: an answer reads only the cursors", () => {
    expect(greeted(fleetGreeting(base)).floor.size).toBe(0);
  });
});

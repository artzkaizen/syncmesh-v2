import type { PeerId } from "@syncmesh/kernel";
import type { LinkEvent } from "@syncmesh/transport";

import { parsePeerId } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { createLinkRing } from "../source/link-ring.js";

const id = (hex: string): PeerId => parsePeerId(hex.repeat(64).slice(0, 64)).unwrap();
const NEAR = id("2");
const AT = Temporal.Instant.fromEpochMilliseconds(1_726_000_000_000);

const ending = (kind: LinkEvent["kind"], transport: string): LinkEvent => ({
  kind,
  transport,
  peer: NEAR,
  why: "a reason",
  at: AT,
});

describe("the ring of link endings", () => {
  test("newest first, because that is the order an endings list is read in", () => {
    const ring = createLinkRing(8);
    ring.note(ending("proven", "lan"));
    ring.note(ending("closed", "lan"));
    expect(ring.recent().map((e) => e.kind)).toEqual(["closed", "proven"]);
  });

  test("a devtool left open overnight does not cost the app its memory", () => {
    const ring = createLinkRing(3);
    for (let n = 0; n < 50; n += 1) ring.note(ending("refused", "ble"));
    expect(ring.recent()).toHaveLength(3);
  });

  test("ids are the source's own count, so a row keeps its identity as the ring turns", () => {
    const ring = createLinkRing(2);
    ring.note(ending("proven", "lan"));
    ring.note(ending("closed", "lan"));
    expect(ring.recent().map((e) => e.id)).toEqual([1, 0]);
    ring.note(ending("dropped", "lan"));
    // the oldest slot has been reused; the ending in it is a different ending with a different id
    expect(ring.recent().map((e) => e.id)).toEqual([2, 1]);
  });

  test("an absent peer stays absent rather than becoming an empty string", () => {
    const ring = createLinkRing();
    ring.note({ kind: "dropped", transport: "ble", why: "a malformed frame", at: AT });
    expect(ring.recent()[0]?.peer).toBeUndefined();
  });

  test("the tally counts what is in the ring, per medium and kind, busiest first", () => {
    const ring = createLinkRing(16);
    ring.note(ending("proven", "lan"));
    ring.note(ending("refused", "ble"));
    ring.note(ending("refused", "ble"));
    ring.note(ending("refused", "ble"));
    expect(ring.tally()).toEqual([
      { transport: "ble", kind: "refused", count: 3 },
      { transport: "lan", kind: "proven", count: 1 },
    ]);
  });

  test("the tally forgets exactly what the ring forgot", () => {
    const ring = createLinkRing(2);
    ring.note(ending("proven", "lan"));
    ring.note(ending("refused", "ble"));
    ring.note(ending("refused", "ble"));
    expect(ring.tally()).toEqual([{ transport: "ble", kind: "refused", count: 2 }]);
  });
});

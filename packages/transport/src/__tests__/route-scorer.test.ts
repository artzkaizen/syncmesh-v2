import type { PeerId } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";

import type { RouteCandidate, RouteMessage } from "../route-scorer.js";

import { KIND } from "../frame-parts.js";
import { ORDINARY_LINK, pickRoutes, scoreRoute } from "../route-scorer.js";

/** The three media RFC-0012 names, as the numbers their adapters would declare. */
const ble = {
  id: "ble",
  online: true,
  direct: true,
  bandwidthBps: 24_000,
} satisfies RouteCandidate;
const relay = {
  id: "relay",
  online: true,
  direct: false,
  bandwidthBps: 8_000_000,
} satisfies RouteCandidate;
const wifiAware = {
  id: "wifi-aware",
  online: true,
  direct: true,
  bandwidthBps: 20_000_000,
  costly: true,
} satisfies RouteCandidate;

const liveEvent = { cls: KIND.event, bytes: 200 } satisfies RouteMessage;
const snapshotPage = { cls: KIND.snapshot, bytes: 2_000_000 } satisfies RouteMessage;
const ids = (picked: readonly RouteCandidate[]) => picked.map((c) => c.id);

/**
 * The relay as it actually ships. The fixture above is a generous 8 Mbps; `ORDINARY_LINK` is
 * what `runTransports` hands a transport that declares nothing, and the difference is the whole
 * of why the saturation below went unnoticed.
 */
const shippedRelay = { id: "relay", online: true, ...ORDINARY_LINK } satisfies RouteCandidate;

describe("a badly penalised link keeps its place in the order", () => {
  test("a 2 MB snapshot ranks the shipped relay above the radio, not alphabetically", () => {
    // both are far past the floor: BLE spends eleven minutes on this, the relay sixteen seconds
    expect(scoreRoute(ble, snapshotPage)).toBeLessThan(scoreRoute(shippedRelay, snapshotPage));
    expect(ids(pickRoutes([ble, shippedRelay], snapshotPage))).toEqual(["relay"]);
    // clamping both to a constant used to break the tie on the name, and "ble" sorts first
    expect(scoreRoute(ble, snapshotPage)).not.toBe(scoreRoute(shippedRelay, snapshotPage));
  });

  test("penalised is still routable: every online link stays above unroutable", () => {
    for (const bytes of [2_000_000, 20_000_000, 200_000_000]) {
      const huge = { cls: KIND.snapshot, bytes } satisfies RouteMessage;
      expect(scoreRoute(ble, huge)).toBeGreaterThan(0);
      expect(ids(pickRoutes([ble], huge))).toEqual(["ble"]);
    }
  });

  test("a bigger payload never scores better on the same link", () => {
    const at = (bytes: number) => scoreRoute(ble, { cls: KIND.snapshot, bytes });
    const sizes = [1_000, 100_000, 1_000_000, 10_000_000, 100_000_000];
    for (const [i, bytes] of sizes.entries())
      if (i > 0) expect(at(bytes)).toBeLessThan(at(sizes[i - 1] ?? 0));
  });
});

/** A fixture peer id from one hex digit. */
const peer = (digit: string) => {
  // SAFETY: 64 lowercase hex characters, which is the whole of what `parsePeerId` checks
  const id = digit.repeat(64) as PeerId;
  return id;
};
const alice = peer("a");
const bob = peer("b");

describe("narrowing to the link that reaches the peer", () => {
  const bleToAlice = { ...ble, reaches: new Set([alice]) } satisfies RouteCandidate;
  const relayToBoth = { ...shippedRelay, reaches: new Set([alice, bob]) } satisfies RouteCandidate;

  test("a frame with no addressee is the broadcast it always was", () => {
    expect(ids(pickRoutes([bleToAlice, relayToBoth], liveEvent))).toEqual(["ble"]);
    expect(ids(pickRoutes([bleToAlice, relayToBoth], { ...liveEvent, redundancy: 2 }))).toEqual([
      "ble",
      "relay",
    ]);
  });

  test("addressed to a peer only one link claims, that link carries it", () => {
    // bob is not on the radio, so the relay wins despite the direct bonus
    expect(ids(pickRoutes([bleToAlice, relayToBoth], { ...liveEvent, to: bob }))).toEqual([
      "relay",
    ]);
    // alice is on both, so the ordinary scoring decides — and a small event wants the radio
    expect(ids(pickRoutes([bleToAlice, relayToBoth], { ...liveEvent, to: alice }))).toEqual([
      "ble",
    ]);
  });

  test("a peer nobody claims falls back to the broadcast, never to nothing", () => {
    const carol = peer("c");
    expect(ids(pickRoutes([bleToAlice, relayToBoth], { ...liveEvent, to: carol }))).toEqual([
      "ble",
    ]);
    // a medium that cannot enumerate its links is never narrowed away by one that can
    expect(ids(pickRoutes([ble, relayToBoth], { ...liveEvent, to: bob }))).toEqual(["relay"]);
    expect(ids(pickRoutes([ble, shippedRelay], { ...liveEvent, to: bob }))).toEqual(["ble"]);
  });

  test("narrowing never empties the set while any link is online", () => {
    const nobody = { ...bleToAlice, reaches: new Set<PeerId>() } satisfies RouteCandidate;
    expect(pickRoutes([nobody], { ...liveEvent, to: bob })).not.toEqual([]);
    expect(pickRoutes([nobody, shippedRelay], { ...liveEvent, to: bob })).not.toEqual([]);
    // offline is still the one fact that removes a candidate outright
    expect(pickRoutes([{ ...nobody, online: false }], { ...liveEvent, to: bob })).toEqual([]);
  });

  test("the order still decides among the links that do claim the peer", () => {
    const page = { cls: KIND.snapshot, bytes: 2_000_000, to: alice } satisfies RouteMessage;
    const relayToAlice = { ...shippedRelay, reaches: new Set([alice]) } satisfies RouteCandidate;
    expect(ids(pickRoutes([bleToAlice, relayToAlice], page))).toEqual(["relay"]);
  });
});

describe("scoring one link against one frame", () => {
  test("an offline candidate is never picked, however good it would otherwise be", () => {
    const dark = { ...wifiAware, online: false };
    expect(scoreRoute(dark, liveEvent)).toBe(0);
    expect(ids(pickRoutes([dark, relay], liveEvent))).toEqual(["relay"]);
    expect(pickRoutes([dark], liveEvent)).toEqual([]);
  });

  test("a small live event prefers the direct radio; the same link is wrong for 2 MB", () => {
    expect(scoreRoute(ble, liveEvent)).toBeGreaterThan(scoreRoute(relay, liveEvent));
    expect(ids(pickRoutes([relay, ble], liveEvent))).toEqual(["ble"]);
    // eleven minutes of blocked radio against a second on the relay
    expect(scoreRoute(ble, snapshotPage)).toBeLessThan(scoreRoute(relay, snapshotPage));
    expect(ids(pickRoutes([ble, relay], snapshotPage))).toEqual(["relay"]);
  });

  test("an expensive radio costs power on frames too small to have needed it", () => {
    const small = { cls: KIND.digest, bytes: 200 } satisfies RouteMessage;
    const smallUrgent = { cls: KIND.event, bytes: 200 } satisfies RouteMessage;
    const plain = { ...wifiAware, costly: false };
    expect(scoreRoute(wifiAware, small)).toBeLessThan(scoreRoute(plain, small));
    // someone waiting buys a discount, not a pass: a cheap open link still carries it instead
    expect(scoreRoute(wifiAware, small)).toBeLessThan(scoreRoute(wifiAware, smallUrgent));
    expect(scoreRoute(wifiAware, smallUrgent)).toBeLessThan(scoreRoute(relay, smallUrgent));
    // a payload big enough to have needed the radio pays nothing for it
    expect(scoreRoute(wifiAware, snapshotPage)).toBe(scoreRoute(plain, snapshotPage));
  });

  test("RFC-0012's typical winners come out of the numbers, not out of a table of names", () => {
    const catchUpPage = { cls: KIND.snapshot, bytes: 14_000 } satisfies RouteMessage;
    const links = [ble, relay, wifiAware];
    // live event: the direct radio. grants and cursors: the cheapest open link, same answer here
    expect(ids(pickRoutes(links, liveEvent))).toEqual(["ble"]);
    expect(ids(pickRoutes(links, { cls: KIND.grant, bytes: 300 }))).toEqual(["ble"]);
    // a catch-up page wants bandwidth; a 2 MB snapshot wants it badly enough to rank the relay
    // above the radio that would spend eleven minutes on it
    expect(ids(pickRoutes(links, catchUpPage))).toEqual(["wifi-aware"]);
    expect(ids(pickRoutes([ble, relay], catchUpPage))).toEqual(["relay"]);
    expect(ids(pickRoutes(links, snapshotPage))).toEqual(["wifi-aware"]);
    expect(scoreRoute(ble, snapshotPage)).toBeLessThan(scoreRoute(relay, snapshotPage));
  });

  test("a dormant radio is not woken by presence, and is still there for an event", () => {
    const asleep = { ...wifiAware, dormant: true };
    expect(scoreRoute(asleep, { cls: KIND.presence, bytes: 64 })).toBe(0);
    expect(pickRoutes([asleep], { cls: KIND.presence, bytes: 64 })).toEqual([]);
    // an event with nowhere else to go still goes: a frame nobody sends is divergence, not routing
    expect(scoreRoute(asleep, liveEvent)).toBeGreaterThan(0);
    expect(ids(pickRoutes([asleep], liveEvent))).toEqual(["wifi-aware"]);
    // but any open link outranks waking it
    expect(scoreRoute(asleep, liveEvent)).toBeLessThan(scoreRoute(relay, liveEvent));
    expect(ids(pickRoutes([asleep, relay], liveEvent))).toEqual(["relay"]);
    // enough bytes pending and the wake is what it is for
    expect(scoreRoute(asleep, snapshotPage)).toBeGreaterThan(scoreRoute(ble, snapshotPage));
  });

  test("redundancy fans out best-first, and asks for no more links than exist", () => {
    const twice = { ...liveEvent, redundancy: 2 } satisfies RouteMessage;
    expect(ids(pickRoutes([relay, ble, wifiAware], twice))).toEqual(["ble", "relay"]);
    expect(ids(pickRoutes([relay], twice))).toEqual(["relay"]);
    expect(ids(pickRoutes([relay, ble], { ...liveEvent, redundancy: 0 }))).toEqual(["ble"]);
  });

  test("the same facts give the same answer: order in, and ties, decide nothing", () => {
    const shuffled = [wifiAware, relay, ble];
    expect(ids(pickRoutes(shuffled, snapshotPage))).toEqual(
      ids(pickRoutes([...shuffled].reverse(), snapshotPage)),
    );
    // identical links differing only in name: the name breaks the tie, not the array order
    const twins = [
      { ...ble, id: "ble:b" },
      { ...ble, id: "ble:a" },
    ];
    expect(ids(pickRoutes(twins, { ...liveEvent, redundancy: 2 }))).toEqual(["ble:a", "ble:b"]);
    expect(ids(pickRoutes([...twins].reverse(), { ...liveEvent, redundancy: 2 }))).toEqual([
      "ble:a",
      "ble:b",
    ]);
  });

  test("it is pure: scoring twice, in any order, says the same thing", () => {
    const first = scoreRoute(ble, liveEvent);
    scoreRoute(relay, snapshotPage);
    expect(scoreRoute(ble, liveEvent)).toBe(first);
  });
});

import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Transport } from "@syncmesh/transport";

import { describe, expect, test } from "bun:test";

import type { AdmissionFacts } from "../admission.js";

import { enforceCeiling } from "../admission.js";
import { createChurn } from "../churn.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- brands the fixture builds whole */
const peer = (n: number): PeerId => String(n).padStart(64, "0") as PeerId;
const seq = (n: number): SeqNum => n as SeqNum;
const SELF = peer(999);
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** A medium that reports links and can close one — the only kind a budget or churn applies to. */
const medium = (name: string, links: number, budget: number) => {
  const reached = new Set<PeerId>(Array.from({ length: links }, (_, i) => peer(i + 1)));
  const dropped: PeerId[] = [];
  const transport = {
    name,
    start: () => Promise.resolve(),
    whenReady: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    reaches: () => reached,
    maxLinks: () => budget,
    drop: (target: PeerId) => {
      reached.delete(target);
      dropped.push(target);
    },
  } satisfies Transport;
  return { transport, dropped };
};

/**
 * What this device knows about each peer. `ahead` says how far past us a peer is — the reason to
 * keep a link at all — and `sharing` how many of our partitions it holds.
 */
const facts = (
  ahead: Readonly<Record<number, number>> = {},
  sharing: Readonly<Record<number, number>> = {},
): AdmissionFacts => ({
  acks: () =>
    new Map(Object.entries(ahead).map(([n, at]) => [peer(Number(n)), new Map([[SELF, seq(at)]])])),
  held: () => new Map([[SELF, seq(0)]]),
  partitionsOf: (device) =>
    device === SELF
      ? ["org:a", "org:b", "org:c"]
      : ["org:a", "org:b", "org:c"].slice(0, sharing[Number(device)] ?? 3),
  self: SELF,
});

describe("churn — what keeps a full room from becoming a clique (book ch. 17)", () => {
  test("a saturated medium gives up its least valuable link, never a random one", () => {
    const radio = medium("ble", 4, 4);
    // peer 3 is holding nothing we lack; the others are ahead of us and worth keeping
    const churn = createChurn(
      () => [radio.transport],
      () => facts({ 1: 90, 2: 40, 3: 0, 4: 120 }),
    );

    expect(churn.now()).toEqual([peer(3)]);
    // and only one: churn opens a slot, it does not clear the room
    expect(radio.transport.reaches().size).toBe(3);
    churn.stop();
  });

  test("with nothing to tell them apart by cursor, the narrower peer goes", () => {
    const radio = medium("ble", 3, 3);
    const churn = createChurn(
      () => [radio.transport],
      () => facts({}, { 1: 3, 2: 1, 3: 3 }),
    );
    // peer 2 shares one partition of ours; a peer sharing less can tell us less
    expect(churn.now()).toEqual([peer(2)]);
    churn.stop();
  });

  test("a medium with a free slot is left alone — a new peer can already be admitted", () => {
    const radio = medium("ble", 4, 6);
    const churn = createChurn(() => [radio.transport], facts);
    expect(churn.now()).toEqual([]);
    churn.stop();
  });

  test("a device's only link is never the one given up: that is the island, not the cure", () => {
    const radio = medium("ble", 1, 1);
    const churn = createChurn(() => [radio.transport], facts);
    expect(churn.now()).toEqual([]);
    expect(radio.transport.reaches().size).toBe(1);
    churn.stop();
  });

  test("a medium that cannot name or close its links is not churned", () => {
    const opaque = {
      name: "relay",
      start: () => Promise.resolve(),
      whenReady: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    } satisfies Transport;
    const churn = createChurn(() => [opaque], facts);
    expect(churn.now()).toEqual([]);
    churn.stop();
  });

  test("every saturated medium is considered, and each gives up one of its own", () => {
    const radio = medium("ble", 6, 6);
    const wifi = medium("lan", 4, 4);
    const churned: string[] = [];
    const churn = createChurn(() => [radio.transport, wifi.transport], facts, {
      onChurned: (_peer, transport) => void churned.push(transport),
    });

    expect(churn.now()).toHaveLength(2);
    expect(churned).toEqual(["ble", "lan"]);
    churn.stop();
  });

  test("the same facts give the same answer twice, so a run is repeatable", () => {
    const first = medium("ble", 4, 4);
    const second = medium("ble", 4, 4);
    const ahead = { 1: 5, 2: 5, 3: 5, 4: 5 }; // a four-way tie, broken by the peer id alone
    expect(
      createChurn(
        () => [first.transport],
        () => facts(ahead),
      ).now(),
    ).toEqual(
      createChurn(
        () => [second.transport],
        () => facts(ahead),
      ).now(),
    );
  });
});

describe("the ceiling — what the process sustains, not what a radio does", () => {
  test("every medium inside its own budget can still be too much at once", () => {
    const radio = medium("ble", 6, 6);
    const wifi = medium("lan", 30, 100);
    // both are within their own limits; the device holding all thirty-six is not
    expect(enforceCeiling([radio.transport, wifi.transport], facts(), 10)).toHaveLength(26);
    expect(radio.transport.reaches().size + wifi.transport.reaches().size).toBe(10);
  });

  test("the cheapest links go first, across mediums", () => {
    const radio = medium("ble", 2, 6);
    const wifi = medium("lan", 2, 100);
    // peers 1 and 2 exist on both mediums; 1 is holding nothing we lack
    const dropped = enforceCeiling([radio.transport, wifi.transport], facts({ 1: 0, 2: 80 }), 2);
    expect(dropped).toEqual([peer(1), peer(1)]);
    expect([...radio.transport.reaches()]).toEqual([peer(2)]);
  });

  test("a device inside the ceiling is left alone", () => {
    const radio = medium("ble", 3, 6);
    expect(enforceCeiling([radio.transport], facts(), 10)).toEqual([]);
    expect(radio.transport.reaches().size).toBe(3);
  });

  test("a medium that cannot name its links is not counted against the ceiling", () => {
    const opaque = {
      name: "relay",
      start: () => Promise.resolve(),
      whenReady: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    } satisfies Transport;
    const radio = medium("ble", 2, 6);
    // it may well be holding a hundred sockets; nothing here can say, and a guess is worse
    expect(enforceCeiling([opaque, radio.transport], facts(), 2)).toEqual([]);
  });
});

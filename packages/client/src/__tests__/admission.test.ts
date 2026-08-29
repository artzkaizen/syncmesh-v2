import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Transport } from "@syncmesh/transport";

import { describe, expect, test } from "bun:test";

import type { AdmissionFacts } from "../admission.js";

import { boundable, enforceBudget } from "../admission.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures: a peer id is 64 hex characters and a sequence number is a count, both supplied literally here */
const peer = (digit: string) => digit.repeat(64) as PeerId;
const seq = (n: number) => n as SeqNum;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const self = peer("0");
/** One author, so "behind" is one subtraction and the test says what it means. */
const author = peer("z");

/**
 * What each peer holds of `author`'s run, against what we hold — and every device granted the
 * same single partition, so overlap is constant and freshness is what decides.
 */
const facts = (holding: Readonly<Record<string, number>>, ours = 0): AdmissionFacts => ({
  acks: () =>
    new Map(
      Object.entries(holding).map(([digit, at]) => [peer(digit), new Map([[author, seq(at)]])]),
    ),
  held: () => new Map([[author, seq(ours)]]),
  partitionsOf: () => ["org:acme"],
  self,
});

const radio = (reaches: readonly string[], maxLinks: number) => {
  const dropped: PeerId[] = [];
  const transport = {
    name: "ble",
    start: () => Promise.resolve(),
    whenReady: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    reaches: () => new Set(reaches.map(peer)),
    maxLinks: () => maxLinks,
    drop: (p: PeerId) => void dropped.push(p),
  } satisfies Transport;
  return { transport, dropped };
};

const digits = (peers: readonly PeerId[]) => peers.map((p) => p.slice(0, 1)).sort();

describe("holding a radio to its budget", () => {
  test("under budget nothing is dropped, however far behind a peer is", () => {
    const { transport, dropped } = radio(["a", "b"], 6);
    const held = facts({ a: 0, b: 99 });

    expect(enforceBudget(transport, held)).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("over budget, the peers holding nothing we lack are the ones cut", () => {
    // a and b are ahead of us; c and d hold nothing we do not already have
    const { transport, dropped } = radio(["a", "b", "c", "d"], 3);
    const held = facts({ a: 50, b: 40, c: 0, d: 0 });

    const cut = enforceBudget(transport, held);
    expect(cut).toHaveLength(1);
    expect(digits(dropped)).toEqual(digits(cut));
    // the two peers with events for us are never the ones dropped
    expect(digits(cut)).not.toContain("a");
    expect(digits(cut)).not.toContain("b");
  });

  test("it drops exactly down to the budget and no further", () => {
    const { transport, dropped } = radio(["a", "b", "c", "d", "e"], 2);
    const held = facts({ a: 5, b: 4, c: 3, d: 2, e: 1 });

    enforceBudget(transport, held);
    expect(dropped).toHaveLength(3); // five links, two slots
  });

  test("a transport that cannot close a link is left alone entirely", () => {
    const { transport } = radio(["a", "b", "c"], 1);
    const { drop: _drop, ...cannotDrop } = transport;
    const held = facts({ a: 1 });

    expect(boundable(transport)).toBe(true);
    expect(boundable(cannotDrop)).toBe(false);
    expect(enforceBudget(cannotDrop, held)).toEqual([]);
  });

  test("a relay declaring no budget is never swept", () => {
    const relay = {
      name: "relay",
      start: () => Promise.resolve(),
      whenReady: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    } satisfies Transport;
    expect(boundable(relay)).toBe(false);
  });
});

import type { PeerId } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";

import type { Neighbour } from "../admission.js";

import { admit, scoreNeighbour } from "../admission.js";

/** A fixture peer id from one hex digit. */
const peer = (digit: string) => {
  // SAFETY: 64 lowercase hex characters, which is the whole of what `parsePeerId` checks
  const id = digit.repeat(64) as PeerId;
  return id;
};

const at = (digit: string, n: Omit<Neighbour, "peer">): Neighbour => ({ peer: peer(digit), ...n });
const ids = (kept: readonly PeerId[]) => kept.map((p) => p.slice(0, 1));
/** Deterministic in place of the random slot: the first of whatever greedy scoring cut. */
const first = (among: readonly Neighbour[]) => among[0];

describe("which neighbours a radio keeps", () => {
  test("under budget nothing is cut, and the rotation slot costs nothing", () => {
    const found = [
      at("a", { behind: 0, shared: 0, quality: 0 }),
      at("b", { behind: 50, shared: 4, quality: 1 }),
    ];
    expect(ids(admit(found, { maxLinks: 6, rotate: first })).sort()).toEqual(["a", "b"]);
  });

  test("coverage beats signal: a strong link to a peer with nothing to say loses", () => {
    const quiet = at("a", { behind: 0, shared: 8, quality: 1 });
    const behind = at("b", { behind: 40, shared: 1, quality: 0 });
    expect(scoreNeighbour(behind)).toBeGreaterThan(scoreNeighbour(quiet));
  });

  test("a live session is not churned for a marginally better candidate", () => {
    const held = at("a", { behind: 20, shared: 4, quality: 0.5, live: true });
    const slightly = at("b", { behind: 22, shared: 4, quality: 0.5 });
    const decisively = at("c", { behind: 64, shared: 8, quality: 1 });

    expect(scoreNeighbour(held)).toBeGreaterThan(scoreNeighbour(slightly));
    expect(scoreNeighbour(decisively)).toBeGreaterThan(scoreNeighbour(held));
  });

  test("one slot is kept for rotation, so greedy scoring cannot form a clique", () => {
    const found = [
      at("a", { behind: 64, shared: 8, quality: 1 }),
      at("b", { behind: 60, shared: 8, quality: 1 }),
      at("c", { behind: 1, shared: 0, quality: 0 }),
      at("d", { behind: 0, shared: 0, quality: 0 }),
    ];
    // two slots: one to the best, one to whoever rotation names out of the rest
    expect(ids(admit(found, { maxLinks: 2, rotate: first }))).toEqual(["a", "b"]);
    // a different rotation reaches a peer greedy scoring would never have kept
    const last = (among: readonly Neighbour[]) => among.at(-1);
    expect(ids(admit(found, { maxLinks: 2, rotate: last }))).toEqual(["a", "d"]);
  });

  test("a one-link radio spends its only slot on the best peer, not on rotation", () => {
    const found = [
      at("a", { behind: 64, shared: 8, quality: 1 }),
      at("b", { behind: 0, shared: 0, quality: 0 }),
    ];
    expect(ids(admit(found, { maxLinks: 1, rotate: first }))).toEqual(["a"]);
  });

  test("the answer is reproducible: equal neighbours break on the peer id, not discovery order", () => {
    const same = { behind: 10, shared: 2, quality: 0.5 };
    const found = [at("c", same), at("a", same), at("b", same)];
    const reversed = [...found].reverse();
    expect(admit(found, { maxLinks: 2, rotate: first })).toEqual(
      admit(reversed, { maxLinks: 2, rotate: first }),
    );
  });

  test("a budget of zero keeps nothing, and never throws", () => {
    expect(admit([at("a", { behind: 1, shared: 1, quality: 1 })], { maxLinks: 0 })).toEqual([]);
  });
});

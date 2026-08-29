import type { PeerId } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";

import type { Neighbour } from "../admission.js";

import { admit, createBackoff, scoreNeighbour } from "../admission.js";

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

describe("waiting before dialling a peer again", () => {
  /** A clock the test moves, so nothing here waits on real time. */
  const clock = () => {
    let ms = 1_000;
    return { now: () => ms, pass: (by: number) => void (ms += by) };
  };

  test("a peer nobody has failed on is ready immediately", () => {
    const backoff = createBackoff({ now: clock().now });
    expect(backoff.ready("a")).toBe(true);
  });

  test("a failed dial is not retried on the next sighting, which is the loop it prevents", () => {
    const time = clock();
    const backoff = createBackoff({ now: time.now, firstMs: 400 });

    backoff.failed("a");
    expect(backoff.ready("a")).toBe(false);
    time.pass(399);
    expect(backoff.ready("a")).toBe(false); // advertisements keep arriving; none of them dials
    time.pass(1);
    expect(backoff.ready("a")).toBe(true);
  });

  test("each failure waits twice as long, up to a ceiling", () => {
    const time = clock();
    const waitAfter = (failures: number) => {
      const fresh = createBackoff({ now: time.now, firstMs: 400, maxMs: 1_600 });
      for (let i = 0; i < failures; i += 1) fresh.failed("a");
      let waited = 0;
      while (!fresh.ready("a") && waited < 10_000) {
        time.pass(100);
        waited += 100;
      }
      return waited;
    };
    expect(waitAfter(1)).toBe(400);
    expect(waitAfter(2)).toBe(800);
    expect(waitAfter(3)).toBe(1_600);
    expect(waitAfter(9)).toBe(1_600); // the ceiling holds, however many times it fails
  });

  test("a session that opens clears the debt, so one bad night costs nothing tomorrow", () => {
    const time = clock();
    const backoff = createBackoff({ now: time.now, firstMs: 400 });

    backoff.failed("a");
    backoff.failed("a");
    backoff.succeeded("a");
    expect(backoff.ready("a")).toBe(true);

    // and the next failure starts from the first wait, not from where it left off
    backoff.failed("a");
    time.pass(400);
    expect(backoff.ready("a")).toBe(true);
  });

  test("peers wait independently: one bad link does not hold up another", () => {
    const backoff = createBackoff({ now: clock().now });
    backoff.failed("a");
    expect(backoff.ready("a")).toBe(false);
    expect(backoff.ready("b")).toBe(true);
  });
});

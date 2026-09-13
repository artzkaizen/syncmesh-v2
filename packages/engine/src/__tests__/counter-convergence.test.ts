import type { MergeSpec } from "@syncmesh/kernel";

import { counterValue, readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import type { Engine } from "../engine.js";

import { createLink } from "../link.js";
import { CREATE, N1, NOTES, PEER_A, PEER_B, column, row, setup } from "./fixtures.js";

/**
 * **A counter column converges to the sum, across engines, however the increments interleave.**
 *
 * The kernel already proves the merge is a lattice over cells (`kernel/__tests__/counter.test.ts`).
 * This is the layer above it and the one an app actually stands on: two engines, each folding its
 * own increments immediately and the other's whenever the link carries them, must agree on the
 * total — and must agree with the arithmetic, not merely with each other.
 *
 * It exists because a field report read 105 views on one install and 76 on another, both saying
 * they were caught up, and the merge was the obvious suspect. It was not: each engine held the
 * identical per-author totals for every author it had, and the disagreement was one author's
 * events that had never reached the second device at all. A counter is the only column shape that
 * makes such a hole *visible* — last-writer-wins over the same seeded value looks identical on a
 * device that is missing half the log — so this test is what says where not to look next time.
 */

const VIEWS = column("views");
const COUNTER: MergeSpec = new Map([[NOTES, new Map([[VIEWS, "counter" as const]])]]);

/** What the app reads: every author's ups minus their downs. `0` for a row nobody has touched. */
const totalOn = (engine: Engine): number => {
  const held = readRow(engine.state(), NOTES, N1)?.get(VIEWS);
  return held === undefined ? 0 : counterValue(held);
};

const bump = async (engine: Engine, by: number): Promise<void> => {
  (await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ views: { "+": by } })))).unwrap();
};

describe("a counter column across two engines", () => {
  test("each device incrementing n times converges on the sum", async () => {
    const a = setup(PEER_A, 100, { merge: COUNTER });
    const b = setup(PEER_B, 100, { merge: COUNTER });
    const link = createLink(a.engine, b.engine);
    link.setOnline(false);

    // apart: nine opens here, four there, and neither device can see the other's
    for (let opened = 0; opened < 9; opened += 1) await bump(a.engine, 1);
    for (let opened = 0; opened < 4; opened += 1) await bump(b.engine, 1);
    expect(totalOn(a.engine)).toBe(9);
    expect(totalOn(b.engine)).toBe(4);

    // the radios come back on first: `catchUp` on an offline link is a no-op that reports success
    link.setOnline(true);
    (await link.catchUp()).unwrap();

    // last-writer-wins would have landed on 1 — the newer `+1` cell, whole
    expect(totalOn(a.engine)).toBe(13);
    expect(totalOn(b.engine)).toBe(13);
    link.close();
  });

  test("increments still arriving while the link is up land exactly once each", async () => {
    const a = setup(PEER_A, 100, { merge: COUNTER });
    const b = setup(PEER_B, 100, { merge: COUNTER });
    const link = createLink(a.engine, b.engine);

    // live forwarding, interleaved, with a catch-up in the middle of the run: an increment folded
    // twice is the failure this shape is looking for, and it reads as a total that is too high
    for (let round = 0; round < 5; round += 1) {
      await bump(a.engine, 2);
      await bump(b.engine, 3);
      if (round === 2) (await link.catchUp()).unwrap();
    }
    await link.flush();
    (await link.catchUp()).unwrap();

    expect(totalOn(a.engine)).toBe(25);
    expect(totalOn(b.engine)).toBe(25);
    link.close();
  });

  test("a decrement is the same lattice: the sum is ups minus downs on both sides", async () => {
    const a = setup(PEER_A, 100, { merge: COUNTER });
    const b = setup(PEER_B, 100, { merge: COUNTER });
    const link = createLink(a.engine, b.engine);
    link.setOnline(false);

    await bump(a.engine, 10);
    await bump(b.engine, -3);
    link.setOnline(true);
    (await link.catchUp()).unwrap();

    expect(totalOn(a.engine)).toBe(7);
    expect(totalOn(b.engine)).toBe(7);
    link.close();
  });

  test("a device missing one author's events is the only way the two totals differ", async () => {
    const a = setup(PEER_A, 100, { merge: COUNTER });
    const b = setup(PEER_B, 100, { merge: COUNTER });
    const link = createLink(a.engine, b.engine);
    link.setOnline(false);

    await bump(a.engine, 29);
    await bump(b.engine, 76);
    link.setOnline(true);
    (await link.catchUp()).unwrap();
    expect(totalOn(a.engine)).toBe(105);
    expect(totalOn(b.engine)).toBe(105);

    // and the shape the field report actually had: the same cell, author for author, except for
    // one author `b` never heard of. Nothing in the merge can close that — only delivery can.
    const cellOf = (engine: Engine) => readRow(engine.state(), NOTES, N1)?.get(VIEWS);
    expect(cellOf(a.engine)).toEqual(cellOf(b.engine));
    link.close();
  });
});

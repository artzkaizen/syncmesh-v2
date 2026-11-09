import { describe, expect, test } from "bun:test";

import { runChaos } from "./run-chaos.js";

/**
 * The chaos harness in CI (gap audit №10): one small seeded run on every test pass, so the
 * convergence oracle, the durability invariant and the zero-handles epilogue guard every push
 * instead of only the runs somebody remembers to start. A failure prints the run's own report;
 * the seed is fixed so a red run replays exactly.
 */
describe("chaos smoke", () => {
  test("a small seeded run converges, holds every acknowledged event, and leaks nothing", async () => {
    const { code, out } = await runChaos(["--seed", "12", "--devices", "4", "--ticks", "8"]);
    expect(out).toContain("converged");
    expect(out).toContain("0 violation(s); digests agree");
    expect(code).toBe(0);
  }, 60_000);

  /**
   * Found by the invariant, in the original schedule with no switch on: `c` (Bluetooth only) lost
   * its session to `b` whenever `b` greeted another central, because a peripheral notifies every
   * subscribed central and the central filed the neighbour's hello under its own link. Fixed by
   * naming the link in every packet (`@syncmesh/ble` `link.ts`, `LINK_TAG_BYTES`); the
   * deterministic replay is `link.test.ts` "two centrals on one peripheral". A seed fixes the
   * schedule for one build only, so these two say only that the seeds that found it still pass.
   */
  test("seed 4, 4 devices, 10 ticks: a neighbour's hello no longer replaces a session", async () => {
    const { code } = await runChaos(["--seed", "4", "--devices", "4", "--ticks", "10"]);
    expect(code).toBe(0);
  }, 60_000);

  test("seed 11, 4 devices, 8 ticks: the same", async () => {
    const { code } = await runChaos(["--seed", "11", "--devices", "4", "--ticks", "8"]);
    expect(code).toBe(0);
  }, 60_000);
});

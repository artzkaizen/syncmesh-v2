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
    const { code, out } = await runChaos(["--seed", "11", "--devices", "4", "--ticks", "8"]);
    expect(out).toContain("converged");
    expect(out).toContain("0 violation(s); digests agree");
    expect(code).toBe(0);
  }, 60_000);

  /**
   * Found by the invariant, in the original schedule with no switch on. `bun src/run.ts --seed 4
   * --devices 4 --ticks 10` fails every time:
   *
   *   VIOLATION held c: lacks b's update of n1 (seq 4, 4bddee55…-4): cursor 3
   *
   * c (Bluetooth only) reaches b and d over the air. At boot the ledger's `medium` lines show
   * `c proven 4bddee55 the peer handshook again; the older session is gone` within a few ms of b
   * handshaking with d, then a steady stream of `the frame did not open under the session key`.
   * The cause, read from the code: a peripheral notifies with `setCharacteristicValue(…, true)`
   * and names no central (`packages/ble/src/link.ts`), so every subscribed central gets every
   * link's frames, and a central files them under its own link to that peripheral
   * (`onCharacteristicValueChanged` in `packages/ble/src/transport.ts`). b's hello to d reads to
   * c as b re-keying, c drops its live session, and nothing re-keys it. The BLE transport's, not
   * the harness's — a sibling team owns it.
   */
  test.todo("seed 4, 4 devices, 10 ticks: a session replaced by a neighbour's hello", async () => {
    const { code } = await runChaos(["--seed", "4", "--devices", "4", "--ticks", "10"]);
    expect(code).toBe(0);
  }, 60_000);
});

import { describe, expect, test } from "bun:test";

import { runChaos } from "./run-chaos.js";

/**
 * One small seeded run per schedule switch (gap audit №11, №12), each asserting the thing its
 * switch exists to exercise actually happened — a grant minted mid-run, a blob read back, a
 * retention refusal recorded — and not only that the run came back green.
 *
 * The seeds marked `todo` are runs the switch made fail on a real bug outside this package. They
 * stay here, failing as written, so the fix has a replay waiting for it.
 */

const small = (seed: number, ...flags: string[]) => [
  "--seed",
  `${seed}`,
  "--devices",
  "4",
  "--ticks",
  "8",
  ...flags,
];

describe("--grants fault", () => {
  test("a device granted mid-run by the issuer is admitted everywhere, and its writes with it", async () => {
    const { code, out, entries } = await runChaos(small(8, "--grants", "fault"));
    const granted = entries.flatMap((entry) => (entry.kind === "granted" ? [entry.device] : []));
    expect(granted).toEqual(["b"]);
    // the late device wrote after its grant, and every replica holds what it wrote
    expect(entries.some((entry) => entry.kind === "authored" && entry.device === "b")).toBe(true);
    expect(out).toContain("converged");
    expect(out).toContain("0 violation(s); digests agree");
    expect(code).toBe(0);
  }, 60_000);

  /**
   * `bun src/run.ts --seed 1 --devices 4 --ticks 8 --grants fault` — DIVERGED, 19 violations,
   * digests disagree on 2. d is granted mid-run; until then b's and c's doors refuse it
   * (`medium`: `refused 19b206c9 the door did not admit this peer`), and the handshakes around
   * those refusals share the air with live sessions. c then logs `proven 4bddee55 the peer
   * handshook again; the older session is gone` twice and 11 `the frame did not open under the
   * session key`, and never hears b again: the BLE peripheral's notifications reach every
   * subscribed central (see the seed-4 note in `smoke.test.ts`). The final snapshots show the
   * grant reached a, b and d through the issuer and the relay; c — Bluetooth only, its sessions
   * gone — never received it. Of seeds 1–30 at this size only 8, 10 and 25 pass.
   */
  test.todo("seed 1: door refusals re-dial into a hijacked BLE session", async () => {
    const { code } = await runChaos(small(1, "--grants", "fault"));
    expect(code).toBe(0);
  }, 60_000);
});

describe("--blobs", () => {
  test("every referenced blob reads back byte-identical wherever a medium carries bytes", async () => {
    const { code, out, entries } = await runChaos(small(1, "--blobs"));
    const puts = entries.filter((entry) => entry.kind === "blob" && entry.op === "put");
    const reads = entries.flatMap((entry) =>
      entry.kind === "blob" && entry.op === "read" ? [`${entry.device} ${entry.outcome}`] : [],
    );
    expect(puts.length).toBeGreaterThan(0);
    // a and b are on the relay and read the bytes; c and d have only Bluetooth, which carries none
    expect(new Set(reads)).toEqual(
      new Set(["a ok", "b ok", "c NoSuchCapability", "d NoSuchCapability"]),
    );
    expect(out).toContain("0 failed read(s)");
    expect(code).toBe(0);
  }, 60_000);

  /**
   * `bun src/run.ts --seed 6 --devices 4 --ticks 8 --blobs` — `blobs: 2 put, 2 failed read(s)`:
   * `VIOLATION blob b: blob b723a7ce0fc0 (473 bytes): BlobTimeout`, same for d. a put it at 140 ms,
   * before its relay link had ever been proven; `put` answered ok. The relay transport's upload
   * is `sendSafe`, which drops a frame when no socket is live, and nothing offers the bytes again
   * on reconnect — so a blob put offline (or before first connect) is acknowledged and never
   * leaves the device. Same shape at seeds 10 and 11.
   */
  test.todo("seed 6: a blob put before the relay is up is acknowledged and never uploaded", async () => {
    const { code } = await runChaos(small(6, "--blobs"));
    expect(code).toBe(0);
  }, 60_000);
});

/**
 * Wall-clock bound: the relay keeps events 400 ms, so whether the sleeper is refused depends on
 * how fast the rest of the run goes. Passes alone; under `vp run -r test`'s parallel load it
 * misses the refusal (measured 2026-11-07). So it runs where nothing shares the CPU: the nightly
 * job sets `SYNCMESH_CHAOS_TIMING=1`.
 */
describe.if(process.env.SYNCMESH_CHAOS_TIMING === "1")("--retention", () => {
  test("a device below the relay's floor is refused as a value, and the invariant still holds", async () => {
    const { code, out, entries } = await runChaos(small(11, "--retention"));
    const refusals = entries.filter((entry) => entry.kind === "refused");
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.every((entry) => entry.kind === "refused" && entry.code === "retention")).toBe(
      true,
    );
    // compaction ran and removed events, and the devices that removed them still count as holding them
    expect(entries.some((entry) => entry.kind === "compacted" && entry.removed > 0)).toBe(true);
    expect(out).toMatch(/[1-9]\d* held by floor or adopted state/);
    expect(out).toContain("0 violation(s); digests agree");
    expect(code).toBe(0);
  }, 60_000);

  /**
   * `bun src/run.ts --seed 1 --devices 4 --ticks 8 --retention` — 6 violations:
   * `VIOLATION held b: lacks a's insert of n0 (seq 2, …): cursor 1, no typed refusal recorded`,
   * and the same for c and d, for a's seq 2 and 3. a is relay-only, went dark mid-run and wrote
   * both while dark. On heal the relay refuses its join with `retention` (recorded), and keeps
   * refusing: the refusal blocks a's *uploads* too, so a's acknowledged writes never reach anyone,
   * and the three devices that lack them were told nothing. A relay-only device has no "somewhere
   * else" to fill its gap from, so it never rejoins. The client also never surfaces the refusal —
   * the transport closes and redials; this harness reads it off the socket's close reason.
   */
  test.todo("seed 1: a refused relay-only device's own writes are silently absent elsewhere", async () => {
    const { code } = await runChaos(small(1, "--retention"));
    expect(code).toBe(0);
  }, 60_000);
});

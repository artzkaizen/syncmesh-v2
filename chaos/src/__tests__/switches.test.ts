import { describe, expect, test } from "bun:test";

import { runChaos } from "./run-chaos.js";

/**
 * One small seeded run per schedule switch (gap audit №11, №12), each asserting the thing its
 * switch exists to exercise actually happened — a grant minted mid-run, a blob read back, a
 * retention refusal recorded — and not only that the run came back green.
 *
 * The seeds named after a bug are runs the switch once made fail on a real bug outside this
 * package; each bug has its own deterministic replay where it was fixed, and these say the seed
 * that found it passes on this build.
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
   * `--seed 1 --devices 4 --ticks 8 --grants fault` diverged on four causes, each with its own
   * deterministic replay: a neighbour's hello replacing a session (`ble` `link.test.ts`), a session
   * answering a fresh one with no hello of its own (`transport` `session.test.ts`), a peer turned
   * away for its backoff never dialled again (`ble` `sighting.test.ts`), and a device granted
   * mid-run refused by every neighbour that could have learned its grant only from it (`transport`
   * `upgrade.test.ts`).
   */
  test("seed 1: a device granted mid-run links over the radio its neighbours refused it on", async () => {
    const { code } = await runChaos(small(1, "--grants", "fault"));
    expect(code).toBe(0);
  }, 60_000);
});

describe("--blobs", () => {
  test("every referenced blob reads back byte-identical wherever a medium carries bytes", async () => {
    const { code, out, entries } = await runChaos(small(5, "--blobs"));
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
   * `--seed 6 --devices 4 --ticks 8 --blobs` once failed two reads with `BlobTimeout`: a blob put
   * before the relay link was up was acknowledged and never uploaded. An upload that cannot leave
   * is now kept and sent on the next seat (`relay` `blob-channel.test.ts`).
   */
  test("seed 6: a blob put before the relay is up reaches every device that can read bytes", async () => {
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
   * `--seed 1 --devices 4 --ticks 8 --retention` once left a relay-only device's writes absent
   * everywhere else: the refusal closed the socket, so nothing it wrote while away ever reached
   * the room. The room now takes what a refused device hands over before it hangs up, and a write
   * made while it waits for state dials once more to hand it over (`relay` `retention.test.ts`,
   * `crates/syncmesh-client/tests/relay_link.rs`).
   */
  test("seed 1: a refused relay-only device's own writes reach everyone else", async () => {
    const { code } = await runChaos(small(1, "--retention"));
    expect(code).toBe(0);
  }, 60_000);
});

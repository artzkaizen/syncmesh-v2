import { describe, expect, test } from "bun:test";

import type { CpuProfile } from "../read.js";

import { readProfile } from "../read.js";

/** A two-frame profile: `inner` on top of `outer`, sampled four times at 1ms. */
const profile: CpuProfile = {
  endTime: 4000,
  nodes: [
    { callFrame: { functionName: "(root)" }, children: [2], id: 1 },
    { callFrame: { functionName: "outer", lineNumber: 3, url: "a/live.js" }, children: [3], id: 2 },
    { callFrame: { functionName: "inner", lineNumber: 9, url: "a/live.js" }, id: 3 },
  ],
  samples: [3, 3, 2, 3],
  startTime: 0,
  timeDeltas: [1000, 1000, 1000, 1000],
};

describe("a profile read two ways", () => {
  test("self time names the leaf, total time names the tree above it", () => {
    const reading = readProfile(profile);
    expect(reading.self[0]?.what).toBe("inner  live.js:9");
    expect(reading.self[0]?.ms).toBe(3);
    // `outer` was on top once and under `inner` three times: 1ms of self, 4ms of total
    expect(reading.total.find((one) => one.what.startsWith("outer"))?.ms).toBe(4);
    expect(reading.self.find((one) => one.what.startsWith("outer"))?.ms).toBe(1);
  });

  test("density buckets by 100ms, so an idle stretch is visible", () => {
    const idle: CpuProfile = { ...profile, endTime: 400_000, timeDeltas: [1000, 1000, 1000, 1000] };
    const reading = readProfile(idle);
    expect(reading.density).toHaveLength(4);
    // every sample landed in the first tenth of a second; the rest of the span is the JS thread
    // with nothing to do, which is the reading that says a stall was not JavaScript's
    expect(reading.density[0]).toBe(4);
    expect(reading.density.slice(1)).toEqual([0, 0, 0]);
  });
});

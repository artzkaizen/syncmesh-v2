import { describe, test } from "bun:test";

// `createHlcClock`, `compareHlc` — every case here comes from plan/epics/E01.md § Tests.

describe("compareHlc", () => {
  test.todo("orders by physical ms first, then logical", () => {});
  test.todo("equal stamps compare 0 — both components", () => {});
});

describe("HlcClock.tick", () => {
  test.todo("a new stamp is strictly greater than the previous one", () => {});
  test.todo("same millisecond → logical increments, physical unchanged", () => {});
  test.todo("next millisecond → physical advances, logical resets to 0", () => {});
  test.todo("wall clock goes backwards → physical holds, logical keeps counting", () => {});
});

describe("HlcClock.receive", () => {
  test.todo("a remote stamp ahead of us ratchets physical forward", () => {});
  test.todo("a remote stamp behind us leaves the clock unchanged", () => {});
  test.todo("same physical → logical becomes max(local, remote) + 1 on next tick", () => {});
  test.todo("a remote stamp beyond maxDrift is clamped, not adopted", () => {});
});

describe("properties", () => {
  test.todo("thousands of ticks under a random backwards-jumping clock stay strictly increasing", () => {});
});

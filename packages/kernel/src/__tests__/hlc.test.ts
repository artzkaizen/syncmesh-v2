import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { compareHlc, createHlcClock } from "../hlc.js";
import { fakeClock, hlc, plain } from "./fixtures.js";

describe("compareHlc", () => {
  test("orders by physical ms first, then logical", () => {
    expect(compareHlc(hlc(1, 9), hlc(2, 0))).toBe(-1);
    expect(compareHlc(hlc(2, 0), hlc(1, 9))).toBe(1);
    expect(compareHlc(hlc(1, 1), hlc(1, 2))).toBe(-1);
    expect(compareHlc(hlc(1, 2), hlc(1, 1))).toBe(1);
  });

  test("equal stamps compare 0 — both components", () => {
    expect(compareHlc(hlc(5, 3), hlc(5, 3))).toBe(0);
    expect(compareHlc(hlc(5, 3), hlc(5, 4))).not.toBe(0);
  });
});

describe("HlcClock.tick", () => {
  test("a new stamp is strictly greater than the previous one", () => {
    const clock = createHlcClock(fakeClock(100));
    const a = clock.tick();
    const b = clock.tick();
    expect(compareHlc(a, b)).toBe(-1);
    expect(clock.last()).toBe(b);
  });

  test("same millisecond → logical increments, physical unchanged", () => {
    const clock = createHlcClock(fakeClock(100));
    expect(plain(clock.tick())).toEqual([100, 0]);
    expect(plain(clock.tick())).toEqual([100, 1]);
    expect(plain(clock.tick())).toEqual([100, 2]);
  });

  test("next millisecond → physical advances, logical resets to 0", () => {
    const wall = fakeClock(100);
    const clock = createHlcClock(wall);
    clock.tick();
    clock.tick();
    wall.set(101);
    expect(plain(clock.tick())).toEqual([101, 0]);
  });

  test("wall clock goes backwards → physical holds, logical keeps counting", () => {
    const wall = fakeClock(100);
    const clock = createHlcClock(wall);
    expect(plain(clock.tick())).toEqual([100, 0]);
    wall.set(50);
    expect(plain(clock.tick())).toEqual([100, 1]);
    wall.set(60);
    expect(plain(clock.tick())).toEqual([100, 2]);
  });
});

describe("HlcClock.receive", () => {
  test("a remote stamp ahead of us ratchets physical forward", () => {
    const clock = createHlcClock(fakeClock(100));
    clock.receive(hlc(500, 3));
    expect(plain(clock.last())).toEqual([500, 3]);
    expect(plain(clock.tick())).toEqual([500, 4]);
  });

  test("a remote stamp behind us leaves the clock unchanged", () => {
    const clock = createHlcClock(fakeClock(100));
    clock.tick();
    clock.receive(hlc(50, 9));
    expect(plain(clock.last())).toEqual([100, 0]);
    expect(plain(clock.tick())).toEqual([100, 1]);
  });

  test("same physical → logical becomes max(local, remote) + 1 on next tick", () => {
    const clock = createHlcClock(fakeClock(100));
    clock.tick();
    clock.receive(hlc(100, 7));
    expect(plain(clock.last())).toEqual([100, 7]);
    expect(plain(clock.tick())).toEqual([100, 8]);
    clock.receive(hlc(100, 2));
    expect(plain(clock.tick())).toEqual([100, 9]);
  });

  test("a remote stamp beyond maxDrift is clamped, not adopted", () => {
    const clock = createHlcClock({
      ...fakeClock(100),
      maxDrift: Temporal.Duration.from({ seconds: 1 }),
    });
    clock.receive(hlc(999_999, 0));
    expect(plain(clock.last())).toEqual([1_100, 0]);
    expect(plain(clock.tick())).toEqual([1_100, 1]);
  });
});

describe("properties", () => {
  test("thousands of ticks under a random backwards-jumping clock stay strictly increasing", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 10_000 }), { minLength: 1_000, maxLength: 3_000 }),
        fc.array(fc.tuple(fc.nat({ max: 10_000 }), fc.nat({ max: 5 })), { maxLength: 200 }),
        (walls, remotes) => {
          const wall = fakeClock(0);
          const clock = createHlcClock(wall);
          let previous = clock.tick();
          walls.forEach((ms, i) => {
            wall.set(ms);
            const remote = remotes[i];
            if (remote !== undefined) clock.receive(hlc(remote[0], remote[1]));
            const next = clock.tick();
            expect(compareHlc(previous, next)).toBe(-1);
            previous = next;
          });
        },
      ),
    );
  });
});

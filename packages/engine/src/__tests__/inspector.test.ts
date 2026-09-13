import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { createInspector } from "../inspector.js";

const ms = (n: number) => Temporal.Duration.from({ milliseconds: n });

const fold = (events: number, keys: number, took: number) =>
  ({ type: "engine.fold", sizes: { events, keys }, duration: ms(took) }) as const;
const relayed = (bytes: number, receivers: number, took: number) =>
  ({ type: "relay.event", sizes: { bytes, receivers }, duration: ms(took) }) as const;

describe("the telemetry inspector — the consumer the union never had (gap audit №24)", () => {
  test("counts and sums every size a variant declares, under its own name", () => {
    const inspector = createInspector();
    inspector.note(fold(3, 4, 1));
    inspector.note(fold(5, 6, 3));

    const stat = inspector.of("engine.fold");
    expect(stat?.count).toBe(2);
    expect(stat?.totals.get("events")).toBe(8);
    expect(stat?.totals.get("keys")).toBe(10);
    expect(stat?.durations.totalMs).toBe(4);
    expect(stat?.durations.meanMs).toBe(2);
    expect(stat?.durations.maxMs).toBe(3);
  });

  test("one reader takes every layer, which is the whole reason the union is one union", () => {
    const inspector = createInspector();
    inspector.note(fold(1, 1, 1));
    inspector.note(relayed(900, 12, 2));
    inspector.note(relayed(100, 3, 4));

    // busiest first, and a tie broken by name so two runs agree
    expect(inspector.stats().map((stat) => stat.type)).toEqual(["relay.event", "engine.fold"]);
    expect(inspector.of("relay.event")?.totals.get("receivers")).toBe(15);
  });

  test("percentiles come off the recent window, and the window is bounded", () => {
    const inspector = createInspector({ keep: 4 });
    for (const took of [100, 100, 100, 100]) inspector.note(fold(1, 1, took));
    expect(inspector.of("engine.fold")?.durations.p95Ms).toBe(100);

    // four fast ones later, the slow window is gone: a relay that recovered is not slow
    for (const took of [1, 1, 1, 1]) inspector.note(fold(1, 1, took));
    const stat = inspector.of("engine.fold");
    expect(stat?.durations.p50Ms).toBe(1);
    expect(stat?.durations.p95Ms).toBe(1);
    // the counts and the totals are not a window, though: those are all time
    expect(stat?.count).toBe(8);
    expect(stat?.durations.totalMs).toBe(404);
    // and the worst it ever saw is still the worst it ever saw
    expect(stat?.durations.maxMs).toBe(100);
  });

  test("p50 and p95 separate a fast majority from a slow tail", () => {
    const inspector = createInspector();
    for (let i = 0; i < 95; i += 1) inspector.note(fold(1, 1, 2));
    for (let i = 0; i < 5; i += 1) inspector.note(fold(1, 1, 500));

    const stat = inspector.of("engine.fold");
    expect(stat?.durations.p50Ms).toBe(2);
    expect(stat?.durations.p95Ms).toBe(2);
    expect(stat?.durations.maxMs).toBe(500);
  });

  test("a report reads as lines a person can paste, slowest first", () => {
    const inspector = createInspector();
    inspector.note(fold(3, 4, 1));
    inspector.note(relayed(900, 12, 50));

    const report = inspector.report();
    expect(report.split("\n")[0]).toContain("relay.event ×1");
    expect(report).toContain("bytes=900 receivers=12");
    expect(report).toContain("engine.fold ×1");
  });

  test("nothing reported reads as nothing reported, rather than as an empty table", () => {
    expect(createInspector().report()).toBe("nothing has been reported yet");
  });

  test("reset forgets everything, which is what a per-run measurement needs", () => {
    const inspector = createInspector();
    inspector.note(fold(1, 1, 1));
    inspector.reset();
    expect(inspector.stats()).toEqual([]);
    expect(inspector.of("engine.fold")).toBeUndefined();
  });
});

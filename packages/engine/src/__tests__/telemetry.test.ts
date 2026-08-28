import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { TelemetryEvent } from "../telemetry.js";

import { timed } from "../telemetry.js";

const ms = (duration: Temporal.Duration) => duration.total({ unit: "milliseconds" });
const ZERO = Temporal.Duration.from({ milliseconds: 0 });

describe("timed", () => {
  test("a synchronous block answers with its value and a duration, not a promise", () => {
    const [value, duration] = timed(() => 41 + 1);
    expect(value).toBe(42);
    expect(ms(duration)).toBeGreaterThanOrEqual(0);
  });

  test("an async block is measured to its settlement, not to the call that started it", async () => {
    const [value, duration] = await timed(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "settled";
    });
    expect(value).toBe("settled");
    // the whole point: timing only the synchronous half would report this as instant
    expect(ms(duration)).toBeGreaterThanOrEqual(15);
  });

  test("a rejecting block rejects, and does not swallow the failure into a duration", async () => {
    let outcome = "resolved";
    try {
      await timed(async () => {
        throw new Error("store failed");
      });
    } catch (cause) {
      outcome = String(cause);
    }
    expect(outcome).toContain("store failed");
  });
});

describe("the one union (D17)", () => {
  test("every variant carries sizes and a duration, so a consumer reads both without narrowing", () => {
    // one of each prefix; the compiler is the real assertion — a variant missing `sizes` or
    // `duration` would not typecheck here at all
    const events: readonly TelemetryEvent[] = [
      {
        type: "engine.mutate",
        sizes: { changes: 2 },
        duration: Temporal.Duration.from({ milliseconds: 1 }),
      },
      {
        type: "mesh.transports.settled",
        sizes: { transports: 3 },
        duration: Temporal.Duration.from({ milliseconds: 2 }),
      },
      {
        type: "relay.event",
        sizes: { bytes: 128, receivers: 4 },
        duration: Temporal.Duration.from({ milliseconds: 3 }),
      },
    ];
    const totals = events.map((event) => Object.values(event.sizes).reduce((a, b) => a + b, 0));
    expect(totals).toEqual([2, 3, 132]);
    expect(events.map((event) => ms(event.duration))).toEqual([1, 2, 3]);
  });

  test("the prefix names the layer, so one consumer can route without a per-layer sink", () => {
    const layer = (event: TelemetryEvent) => event.type.split(".")[0];
    const seen = [
      layer({ type: "engine.fold", sizes: { events: 1, keys: 1 }, duration: ZERO }),
      layer({
        type: "mesh.blob.put",
        sizes: { bytes: 9 },
        duration: ZERO,
      }),
      layer({ type: "relay.blob.get", sizes: { bytes: 0 }, duration: ZERO }),
    ];
    expect(seen).toEqual(["engine", "mesh", "relay"]);
  });
});

import { describe, expect, test } from "bun:test";

import { Temporal } from "../index.js";

describe("@syncmesh/temporal", () => {
  test("is the polyfill, not the runtime's Temporal, so every device agrees", () => {
    // SAFETY: probing whether this runtime exposes a native Temporal; the value is only compared by identity
    const native = (globalThis as { Temporal?: unknown }).Temporal;
    expect(Temporal).not.toBe(native);
  });

  test("instants and durations round-trip through epoch milliseconds", () => {
    const t = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
    const d = Temporal.Duration.from({ milliseconds: 5_000 });
    expect(t.add(d).epochMilliseconds).toBe(1_700_000_005_000);
    expect(Temporal.Instant.compare(t, t.add(d))).toBe(-1);
  });
});

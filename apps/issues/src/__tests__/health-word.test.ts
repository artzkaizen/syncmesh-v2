import type { Reading, Source } from "@syncmesh/react";

import { describe, expect, test } from "bun:test";

import { healthWord } from "../app/health-word.js";

const source = (condition: Source["condition"]): Source => ({
  kind: "unknown",
  condition,
  reaches: undefined,
  forced: false,
});

const reading = (health: Reading["health"], ...conditions: Source["condition"][]): Reading => ({
  health,
  sources: new Map(conditions.map((condition, at) => [`medium-${String(at)}`, source(condition)])),
});

describe("the one word the pill says", () => {
  test("caught up says nothing, whatever the media are doing", () => {
    expect(healthWord(reading("local-ready", "ok"))).toBeUndefined();
    expect(healthWord(reading("local-ready"))).toBeUndefined();
  });

  test("catching up is Syncing, ahead of any medium's condition", () => {
    expect(healthWord(reading("catching-up", "ok"))).toBe("Syncing…");
    expect(healthWord(reading("catching-up", "connecting-failed"))).toBe("Syncing…");
  });

  test("a medium that is retrying is Reconnecting, even while nothing carries", () => {
    expect(healthWord(reading("offline", "connecting-failed"))).toBe("Reconnecting…");
    expect(healthWord(reading("offline", "radio-off", "temporarily-unavailable"))).toBe(
      "Reconnecting…",
    );
    // and while another medium carries: the word is about the one that is trying
    expect(healthWord(reading("local-ready", "ok", "temporarily-unavailable"))).toBe(
      "Reconnecting…",
    );
  });

  test("offline is left for media a retry does not fix", () => {
    expect(healthWord(reading("offline", "radio-off"))).toBe("Offline");
    expect(healthWord(reading("offline", "no-permission-central", "no-hardware"))).toBe("Offline");
    expect(healthWord(reading("offline"))).toBe("Offline");
  });

  test("the words that are not the pill's say nothing", () => {
    expect(healthWord(reading("opening"))).toBeUndefined();
    expect(healthWord(reading("blocked-recovery", "ok"))).toBeUndefined();
  });
});

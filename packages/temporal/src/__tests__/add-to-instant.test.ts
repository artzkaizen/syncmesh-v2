import { describe, expect, test } from "bun:test";

import { Temporal, addToInstant } from "../index.js";

const NOW = Temporal.Instant.from("2026-03-28T12:00:00Z");

describe("addToInstant", () => {
  test("reads days as UTC calendar days, which an Instant alone refuses", () => {
    expect(() => NOW.add(Temporal.Duration.from({ days: 2 }))).toThrow(RangeError);
    expect(addToInstant(NOW, Temporal.Duration.from({ days: 2 })).toString()).toBe(
      "2026-03-30T12:00:00Z",
    );
  });

  test("a negated duration moves backwards", () => {
    const back = addToInstant(NOW, Temporal.Duration.from({ hours: 36 }).negated());
    expect(back.toString()).toBe("2026-03-27T00:00:00Z");
  });
});

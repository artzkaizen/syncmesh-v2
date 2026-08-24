import { describe, expect, test } from "bun:test";

import { isVisible } from "../record.js";
import { cell, PEER_A, PEER_B, record, stamp } from "./fixtures.js";

describe("isVisible", () => {
  test("a row that was never deleted is visible", () => {
    expect(isVisible(record(stamp(1, 0, PEER_A)))).toBe(true);
    expect(
      isVisible(record(stamp(1, 0, PEER_A), [["title", cell("x", stamp(1, 0, PEER_A))]])),
    ).toBe(true);
  });

  test("a delete newer than the last write hides the row", () => {
    expect(isVisible(record(stamp(1, 0, PEER_A), [], stamp(2, 0, PEER_A)))).toBe(false);
    expect(isVisible(record(stamp(1, 0, PEER_A), [], stamp(1, 1, PEER_A)))).toBe(false);
    expect(isVisible(record(stamp(1, 0, PEER_A), [], stamp(1, 0, PEER_B)))).toBe(false);
  });

  test("a write newer than the last delete makes the row visible again", () => {
    expect(isVisible(record(stamp(3, 0, PEER_A), [], stamp(2, 0, PEER_B)))).toBe(true);
    expect(isVisible(record(stamp(2, 1, PEER_A), [], stamp(2, 0, PEER_A)))).toBe(true);
    expect(isVisible(record(stamp(2, 0, PEER_B), [], stamp(2, 0, PEER_A)))).toBe(true);
  });

  test("equal write and delete stamps → not visible (strictly greater wins)", () => {
    expect(isVisible(record(stamp(2, 0, PEER_A), [], stamp(2, 0, PEER_A)))).toBe(false);
  });
});

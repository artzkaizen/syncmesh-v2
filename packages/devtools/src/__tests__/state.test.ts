import { describe, expect, test } from "bun:test";

import { MAX_SIZE_RATIO, MIN_SIZE, clampSize, sizeFromPointer } from "../state.js";

describe("panel geometry", () => {
  test("never shrinks below the size at which the panel stops being one", () => {
    expect(clampSize(10, 1000)).toBe(MIN_SIZE);
  });

  test("leaves the host page a strip of itself", () => {
    expect(clampSize(10_000, 1000)).toBe(Math.floor(1000 * MAX_SIZE_RATIO));
  });

  test("re-clamps a size remembered from a larger screen", () => {
    expect(clampSize(900, 600)).toBe(Math.floor(600 * MAX_SIZE_RATIO));
  });

  test("keeps the floor when the viewport is smaller than the minimum", () => {
    expect(clampSize(10, 100)).toBe(MIN_SIZE);
  });

  test("a drag towards the far edge grows the panel", () => {
    expect(sizeFromPointer(400, 1000)).toBe(600);
    expect(sizeFromPointer(200, 1000)).toBe(800);
  });
});

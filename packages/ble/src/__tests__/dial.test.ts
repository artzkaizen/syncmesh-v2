import { describe, expect, test } from "bun:test";

import { discovery, shouldDial } from "../dial.js";

describe("who dials", () => {
  test("exactly one end of every pair, and both agree without asking", () => {
    expect(shouldDial("aaaaaaaa", "bbbbbbbb")).toBe(true);
    expect(shouldDial("bbbbbbbb", "aaaaaaaa")).toBe(false);
    // the property that matters: never both, and never neither
    for (const [x, y] of [
      ["aaaaaaaa", "bbbbbbbb"],
      ["bbbbbbbb", "cccccccc"],
      ["aaaaaaaa", "cccccccc"],
    ] as const) {
      expect(shouldDial(x, y)).not.toBe(shouldDial(y, x));
    }
  });
});

describe("who is nearby", () => {
  const clock = (start = 0) => {
    let now = start;
    return { now: () => now, advance: (ms: number) => void (now += ms) };
  };

  test("found once, however many times the radio repeats it", () => {
    const time = clock();
    const seen = discovery({ now: time.now });
    expect(seen.sighted("aaaaaaaa", "device-1")).toBe(true);
    // a scan with duplicates on reports the same device several times a second; a transport
    // attaching on each one would rebuild the link continuously
    expect(seen.sighted("aaaaaaaa", "device-1")).toBe(false);
    expect(seen.sighted("aaaaaaaa", "device-1")).toBe(false);
    expect(seen.known()).toBe(1);
  });

  test("forgotten after it has genuinely gone quiet", () => {
    const time = clock();
    const seen = discovery({ ttlMs: 1000, now: time.now });
    seen.sighted("aaaaaaaa", "device-1");
    time.advance(500);
    expect(seen.lost(() => false)).toEqual([]);
    time.advance(600);
    expect(seen.lost(() => false)).toEqual(["aaaaaaaa"]);
    expect(seen.known()).toBe(0);
  });

  test("a connected peer that stops advertising is kept — that is iOS behaving normally", () => {
    const time = clock();
    const seen = discovery({ ttlMs: 1000, now: time.now });
    seen.sighted("aaaaaaaa", "device-1");
    seen.sighted("bbbbbbbb", "device-2");
    time.advance(5000);

    // two connected iOS devices stop surfacing each other entirely, so a TTL alone would drop a
    // peer at precisely the moment it was working
    expect(seen.lost((hint) => hint === "aaaaaaaa")).toEqual(["bbbbbbbb"]);
    expect(seen.known()).toBe(1);

    // and it stays kept on the next sweep, rather than aging out from the same stale sighting
    time.advance(5000);
    expect(seen.lost((hint) => hint === "aaaaaaaa")).toEqual([]);
  });

  test("the peripheral id follows the latest advertisement, because it can change", () => {
    const seen = discovery();
    seen.sighted("aaaaaaaa", "device-1");
    expect(seen.peripheralFor("aaaaaaaa")).toBe("device-1");
    expect(seen.peripheralFor("bbbbbbbb")).toBeUndefined();
  });
});

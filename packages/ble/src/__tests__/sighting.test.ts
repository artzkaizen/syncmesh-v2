import { describe, expect, test } from "bun:test";

import type { Rungs } from "../sighting.js";

import { judge } from "../sighting.js";

/** Every rung open, and silent by default, so a test names only what it is changing. */
const open = (shut: Partial<Rungs> = {}): Rungs => ({
  announced: () => false,
  fresh: () => true,
  mine: () => true,
  ours: () => true,
  ready: () => true,
  ...shut,
});

const SELF = "a1b2";

describe("what a radio decides about an advertisement", () => {
  test("nothing refused it, so it is dialled", () => {
    expect(judge("c3d4", SELF, open())).toBe("dialling");
  });

  test("each rung names itself", () => {
    expect(judge(SELF, SELF, open())).toBe("self");
    expect(judge("c3d4", SELF, open({ ours: () => false }))).toBe("another-fleet");
    expect(judge("c3d4", SELF, open({ fresh: () => false }))).toBe("already-known");
    expect(judge("c3d4", SELF, open({ mine: () => false }))).toBe("theirs-to-dial");
    expect(judge("c3d4", SELF, open({ ready: () => false }))).toBe("backing-off");
  });

  test("a rung below a refusal is never asked", () => {
    /**
     * `fresh` records the sighting as it answers, so asking it about an advertisement already
     * refused as another fleet's would keep a stranger's phone alive in this device's own
     * discovery table — and it would be re-judged, and re-refused, for as long as it was in range.
     */
    const asked: string[] = [];
    const verdict = judge("c3d4", SELF, {
      announced: () => true,
      fresh: () => (asked.push("fresh"), true),
      mine: () => (asked.push("mine"), true),
      ours: () => (asked.push("ours"), false),
      ready: () => (asked.push("ready"), true),
    });
    expect(verdict).toBe("another-fleet");
    expect(asked).toEqual(["ours"]);
  });

  test("the rungs are asked in the order a scan result meets them", () => {
    const asked: string[] = [];
    judge("c3d4", SELF, {
      announced: () => true,
      fresh: () => (asked.push("fresh"), true),
      mine: () => (asked.push("mine"), true),
      ours: () => (asked.push("ours"), true),
      ready: () => (asked.push("ready"), true),
    });
    expect(asked).toEqual(["ours", "fresh", "mine", "ready"]);
  });

  /**
   * The case a backgrounded iPhone is: iOS ignores the local name in the background and cannot
   * advertise service data at all, so the only identifier that arrives is the peripheral id.
   * Before this, the sighting was dropped and the pair never relinked.
   */
  test("an advertisement that named nobody is still dialled, on the scan filter's word", () => {
    expect(judge(undefined, SELF, open())).toBe("dialling-unnamed");
  });

  /**
   * The line between the two, and the reason it is drawn at *silence* rather than at *no hint*.
   *
   * Somebody's headphones announce a local name that is not a hint; a backgrounded iPhone
   * announces nothing at all. Dialling on "no hint" would spend a connection on every BLE device
   * in the room — and on Android it really would, because a scanner is handed results its own
   * filter excluded whenever another app scans unfiltered.
   */
  test("a device that announced something unreadable is somebody else's, and stays refused", () => {
    expect(judge(undefined, SELF, open({ announced: () => true }))).toBe("unreadable");
  });

  test("an unnamed peer still faces every rung that does not need a name", () => {
    expect(judge(undefined, SELF, open({ ours: () => false }))).toBe("another-fleet");
    expect(judge(undefined, SELF, open({ fresh: () => false }))).toBe("already-known");
    expect(judge(undefined, SELF, open({ ready: () => false }))).toBe("backing-off");
  });

  test("`shouldDial` is skipped without a name, because it has nothing to compare", () => {
    // the end that could not announce itself is the backgrounded one, and its own scanning is
    // throttled too far to dial us — so waiting for it to take the turn would wait forever
    const asked: string[] = [];
    const verdict = judge(undefined, SELF, {
      announced: () => false,
      fresh: () => true,
      mine: () => (asked.push("mine"), false),
      ours: () => true,
      ready: () => true,
    });
    expect(verdict).toBe("dialling-unnamed");
    expect(asked).toEqual([]);
  });
});

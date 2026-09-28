import { PEER_A, PEER_B } from "@syncmesh/kernel/test-fixtures";
import { describe, expect, test } from "bun:test";

import {
  GROUP_TAG_BYTES,
  HINT_CHARS,
  advertisement,
  groupFrom,
  groupTag,
  hintFrom,
  hintOf,
} from "../advert.js";
import { shouldDial } from "../dial.js";

const SERVICE = "19d74c40-95d0-4b3c-a4a3-d4a8c8bdfe01";

describe("what a device says before anyone has connected", () => {
  test("the whole advertisement stays inside what a BLE payload can hold", () => {
    const advert = advertisement(PEER_A, SERVICE);
    // 31 bytes total: three for flags, eighteen for a 128-bit service UUID, and a name costs its
    // own two-byte header — so the name has to be short, which is the reason for a hint at all
    expect(advert.localName.length).toBe(HINT_CHARS);
    expect(3 + 18 + 2 + advert.localName.length).toBeLessThanOrEqual(31);
  });

  test("the same hint travels in both fields, because the platforms disagree about which survives", () => {
    const advert = advertisement(PEER_A, SERVICE);
    expect(hintFrom({ localName: advert.localName }, SERVICE)).toBe(hintOf(PEER_A));
    expect(hintFrom({ serviceDataBase64: advert.serviceDataBase64 }, SERVICE)).toBe(hintOf(PEER_A));
  });

  test("someone else's advertisement reads as nothing rather than as a peer", () => {
    expect(hintFrom({ localName: "Jeff's Headphones" }, SERVICE)).toBeUndefined();
    expect(hintFrom({}, SERVICE)).toBeUndefined();
    expect(hintFrom({ localName: "zzzzzzzz" }, SERVICE)).toBeUndefined(); // right length, not hex
    expect(hintFrom({ serviceDataBase64: { [SERVICE]: "not base64!" } }, SERVICE)).toBeUndefined();
  });

  test("different peers get different hints, and the dial rule holds on them", () => {
    const a = hintOf(PEER_A);
    const b = hintOf(PEER_B);
    expect(a).not.toBe(b);
    expect(shouldDial(a, b)).not.toBe(shouldDial(b, a));
  });

  test("a hint is a prefix of the id and nothing more — identity is the bridge's job", () => {
    expect(String(PEER_A).startsWith(hintOf(PEER_A))).toBe(true);
    expect(hintOf(PEER_A)).toHaveLength(HINT_CHARS);
  });
});

describe("the group, in the four bytes the scan response has to spare", () => {
  test("a hint still reads back whole when a group follows it", () => {
    const advert = advertisement(PEER_A, SERVICE, "ward-3");
    expect(hintFrom(advert, SERVICE)).toBe(hintOf(PEER_A));
  });

  test("two fleets tag differently; the same fleet tags the same on every device", () => {
    expect(groupTag("ward-3")).not.toEqual(groupTag("depot"));
    expect(groupTag("ward-3")).toEqual(groupTag("ward-3"));
    expect(groupTag("ward-3")).toHaveLength(GROUP_TAG_BYTES);
  });

  test("an advertisement with no group reads as no group, rather than as somebody else's", () => {
    // what an older build puts in the air, and what a platform that drops service data leaves
    expect(groupFrom(advertisement(PEER_A, SERVICE), SERVICE)).toBeUndefined();
    expect(groupFrom({ serviceDataBase64: undefined }, SERVICE)).toBeUndefined();
  });

  test("a group survives the round trip, so a scanner can compare it to its own", () => {
    const heard = groupFrom(advertisement(PEER_A, SERVICE, "ward-3"), SERVICE);
    expect(heard).toEqual(groupTag("ward-3"));
  });
});

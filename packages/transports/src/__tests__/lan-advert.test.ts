import { parsePeerId } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { MAX_ROOM_BYTES, announcement, readAnnouncement } from "../lan/advert.js";

const PEER = parsePeerId("a3".repeat(32)).unwrap();

describe("what a device puts on the group", () => {
  test("the whole peer id survives the round trip, which is the difference from a radio", () => {
    const heard = readAnnouncement(announcement(PEER, "room", 47_101));
    expect(heard?.peer).toBe(PEER);
    expect(heard?.room).toBe("room");
    expect(heard?.port).toBe(47_101);
  });

  test("a room id with accents keeps its bytes, because the length is bytes and not characters", () => {
    const heard = readAnnouncement(announcement(PEER, "café-salle", 1));
    expect(heard?.room).toBe("café-salle");
  });

  test("somebody else's protocol on a group we share is discarded rather than parsed", () => {
    expect(readAnnouncement(new Uint8Array(0))).toBeUndefined();
    expect(readAnnouncement(new TextEncoder().encode("hello?"))).toBeUndefined();
    // ours, but truncated in flight: a length that does not match the body is not an announcement
    const short = announcement(PEER, "room", 1).slice(0, 20);
    expect(readAnnouncement(short)).toBeUndefined();
  });

  test("a version we do not speak is ignored, not guessed at", () => {
    const future = announcement(PEER, "room", 1);
    future[4] = 99;
    expect(readAnnouncement(future)).toBeUndefined();
  });

  test("trailing bytes are not accepted, because a padded announcement is somebody's mistake", () => {
    const padded = new Uint8Array([...announcement(PEER, "room", 1), 0, 0]);
    expect(readAnnouncement(padded)).toBeUndefined();
  });

  test("a room id too long to travel fails where it is written, not on every beat", () => {
    expect(() => announcement(PEER, "r".repeat(MAX_ROOM_BYTES + 1), 1)).toThrow("holds");
  });
});

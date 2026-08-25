import { PEER_ID_HEX, parsePeerId } from "@syncmesh/kernel";
import {
  eventId,
  parseEventId,
  parsePartitionKey,
  parseSeqNum,
  stampOf,
  type SyncEvent,
} from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { hlcAt, PEER_A, procedure, seq } from "./fixtures.js";

describe("parseSeqNum", () => {
  test("accepts positive safe integers", () => {
    expect(parseSeqNum(1).isOk()).toBe(true);
    expect(parseSeqNum(Number.MAX_SAFE_INTEGER).isOk()).toBe(true);
  });

  test("rejects zero, negatives, fractions, unsafe and non-finite numbers as a value", () => {
    for (const bad of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const r = parseSeqNum(bad);
      expect(r.isErr() && r.error._tag).toBe("InvalidSeqNum");
    }
  });
});

describe("eventId", () => {
  test("is `${peerId}-${seqNum}`", () => {
    expect(String(eventId(PEER_A, seq(7)))).toBe(`${PEER_A}-7`);
  });

  test("parseEventId round-trips", () => {
    const parsed = parseEventId(eventId(PEER_A, seq(42))).unwrap();
    expect(parsed.peerId).toBe(PEER_A);
    expect(parsed.seqNum).toBe(seq(42));
    expect(parsed.local).toBe(false);
  });

  test("a local write and a synced write with the same number never share an id", () => {
    const local = eventId(PEER_A, seq(42), true);
    expect(local).not.toBe(eventId(PEER_A, seq(42)));
    expect(parseEventId(local).unwrap()).toEqual({ peerId: PEER_A, seqNum: seq(42), local: true });
  });

  test("parseEventId rejects malformed ids as a value", () => {
    for (const bad of [
      "",
      "nope",
      `${PEER_A}`,
      `${PEER_A}-`,
      `${PEER_A}-0`,
      `${PEER_A}-x`,
      `${"A".repeat(64)}-1`,
      `${PEER_A}-1-2`,
    ]) {
      const r = parseEventId(bad);
      expect(r.isErr() && r.error._tag).toBe("InvalidEventId");
    }
  });

  test("property: every valid (peerId, seqNum) round-trips", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(PEER_ID_HEX),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        (hex, n) => {
          const peerId = parsePeerId(hex).unwrap();
          const parsed = parseEventId(eventId(peerId, seq(n))).unwrap();
          expect(parsed).toEqual({ peerId, seqNum: seq(n), local: false });
        },
      ),
    );
  });
});

describe("stampOf", () => {
  test("is the event's hlc and author", () => {
    const event: SyncEvent = {
      v: 1,
      id: eventId(PEER_A, seq(1)),
      peerId: PEER_A,
      seqNum: seq(1),
      hlc: hlcAt(5),
      procedure: procedure("notes.create"),
      changes: [],
    };
    expect(stampOf(event)).toEqual({ hlc: event.hlc, peer: PEER_A });
  });
});

describe("parsePartitionKey", () => {
  test("kind:id only", () => {
    expect(parsePartitionKey("org:acme").isOk()).toBe(true);
    expect(parsePartitionKey("shelf:s-1_x").isOk()).toBe(true);
    for (const bad of ["acme", "org:", ":acme", "Org:acme", "org:a b", "org:a:b"])
      expect(parsePartitionKey(bad).isErr()).toBe(true);
  });
});

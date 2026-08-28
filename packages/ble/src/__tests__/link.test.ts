import { describe, expect, test } from "bun:test";

import type { LinkOptions } from "../link.js";

import { base64ToBytes, bytesToBase64 } from "../base64.js";
import { bleLink } from "../link.js";
import {
  ATT_MAX_ATTRIBUTE_LENGTH,
  MINIMUM_PAYLOAD,
  notifyLimit,
  subscriberLimit,
  writeLimit,
} from "../radio.js";

const SERVICE = "19d74c40-95d0-4b3c-a4a3-d4a8c8bdfe01";
const CHAR = "19d74c41-95d0-4b3c-a4a3-d4a8c8bdfe01";

/** A radio that records what left and by which primitive; `fail` makes the next send reject. */
const fakeRadio = () => {
  const writes: string[] = [];
  const notifies: string[] = [];
  let reject: Error | undefined;
  const radio = {
    write: (_connection, _service, _characteristic, value) => {
      if (reject !== undefined) return Promise.reject(reject);
      writes.push(value);
      return Promise.resolve();
    },
    setCharacteristicValue: (_service, _characteristic, value) => {
      if (reject !== undefined) return Promise.reject(reject);
      notifies.push(value);
      return Promise.resolve();
    },
    disconnect: () => Promise.resolve(),
  } satisfies LinkOptions["radio"];
  return { radio, writes, notifies, fail: (why: Error) => void (reject = why) };
};

const settle = () => new Promise((r) => setTimeout(r, 0));
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 3 + 1) % 251);

describe("a BLE link", () => {
  test("the dialler writes; the dialled end notifies — the role is which one it holds", async () => {
    const a = fakeRadio();
    const dialler = bleLink({
      radio: a.radio,
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      peer: "b",
      connectionId: "conn-1",
      limit: () => 185,
    });
    const dialled = bleLink({
      radio: a.radio,
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      peer: "a",
      limit: () => 185,
    });

    dialler.send(bytes(20));
    dialled.send(bytes(20));
    await settle();

    expect(a.writes).toHaveLength(1);
    expect(a.notifies).toHaveLength(1);
  });

  test("a frame goes out fragmented and comes back whole", async () => {
    const a = fakeRadio();
    const tx = bleLink({
      radio: a.radio,
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      peer: "b",
      connectionId: "c",
      limit: () => 60,
    });
    const rx = bleLink({
      radio: a.radio,
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      peer: "a",
      limit: () => 60,
    });
    const got: Uint8Array[] = [];
    rx.onFrame((f) => void got.push(f));

    const frame = bytes(500);
    tx.send(frame);
    await settle();
    expect(a.writes.length).toBeGreaterThan(1); // it really was split
    for (const packet of a.writes) rx.accept(packet);
    expect(got).toEqual([frame]);
  });

  test("a write that never left makes the next send throw, and says the link is down", async () => {
    const a = fakeRadio();
    const failures: unknown[] = [];
    const link = bleLink({
      radio: a.radio,
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      peer: "b",
      connectionId: "c",
      limit: () => 185,
      onFailed: (cause) => void failures.push(cause),
    });

    a.fail(new Error("gatt write failed"));
    link.send(bytes(10)); // the failure is asynchronous — this call cannot know yet
    await settle();

    // the transport is told once, so it can tear the link down and re-dial
    expect(failures).toHaveLength(1);
    // and every later send is loud rather than queued onto a radio that is not carrying anything
    expect(() => link.send(bytes(10))).toThrow(/link to b is down/);
  });

  test("a frame too big for the link's own limit throws rather than going out truncated", () => {
    const a = fakeRadio();
    const link = bleLink({
      radio: a.radio,
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      peer: "b",
      connectionId: "c",
      limit: () => 4, // no room for a header
    });
    expect(() => link.send(bytes(10))).toThrow();
  });

  test("junk off the radio is dropped with a reason, never decoded halfway", () => {
    const a = fakeRadio();
    const dropped: string[] = [];
    const link = bleLink({
      radio: a.radio,
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      peer: "b",
      limit: () => 185,
      onDropped: (why) => void dropped.push(why),
    });
    const got: Uint8Array[] = [];
    link.onFrame((f) => void got.push(f));

    link.accept("this is not base64!!");
    expect(got).toEqual([]);
    expect(dropped[0]).toContain("not base64");
  });

  test("the limit is read per send, so a renegotiated MTU takes effect without a new link", async () => {
    const a = fakeRadio();
    let mtu = 23;
    const link = bleLink({
      radio: a.radio,
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      peer: "b",
      connectionId: "c",
      limit: () => writeLimit(mtu),
    });
    link.send(bytes(200));
    await settle();
    const narrow = a.writes.length;

    a.writes.length = 0;
    mtu = 517; // the two ends agreed on more after the first exchange
    link.send(bytes(200));
    await settle();
    expect(a.writes.length).toBeLessThan(narrow);
    expect(a.writes).toHaveLength(1);
  });
});

describe("what one packet may carry", () => {
  test("ATT's three bytes come off the top, and 20 is the floor nothing goes below", () => {
    expect(notifyLimit(185)).toBe(182);
    expect(notifyLimit(23)).toBe(MINIMUM_PAYLOAD);
    expect(notifyLimit(undefined)).toBe(MINIMUM_PAYLOAD);
    expect(notifyLimit(3)).toBe(MINIMUM_PAYLOAD); // a nonsense MTU cannot make it negative
  });

  test("a write stops at the attribute maximum, which the MTU alone does not reach", () => {
    // measured against a real stack through `rn-ble`'s netsim harness: at the default 517-byte
    // MTU the PDU has room for 514 and the write is refused with INVALID_ATTRIBUTE_LENGTH.
    // Sizing writes off the MTU alone makes every packet at that MTU one that never lands
    expect(notifyLimit(517)).toBe(514);
    expect(writeLimit(517)).toBe(ATT_MAX_ATTRIBUTE_LENGTH);
    expect(writeLimit(517)).toBeLessThan(notifyLimit(517));

    // below the crossover the two agree, which is why nothing caught this at a typical MTU
    expect(writeLimit(185)).toBe(notifyLimit(185));
    expect(writeLimit(515)).toBe(notifyLimit(515));
    expect(writeLimit(516)).toBe(ATT_MAX_ATTRIBUTE_LENGTH);
  });

  test("a subscriber's stated limit is a payload already, not an MTU to take ATT off", () => {
    // iOS reports what a notification may carry, with ATT's bytes already gone; taking them off
    // again spends three bytes of every notification on nothing
    expect(subscriberLimit(182)).toBe(182);
    expect(subscriberLimit(undefined)).toBe(MINIMUM_PAYLOAD);
    expect(subscriberLimit(5)).toBe(MINIMUM_PAYLOAD);
  });
});

describe("base64 at the radio boundary", () => {
  test("round-trips every length, so padding is not guessed at", () => {
    for (let n = 0; n < 24; n += 1) {
      const raw = bytes(n);
      expect(base64ToBytes(bytesToBase64(raw)).unwrap()).toEqual(raw);
    }
  });

  test("every byte value survives, including the high half", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64ToBytes(bytesToBase64(all)).unwrap()).toEqual(all);
  });

  test("junk is a value, never a throw and never a half-decode", () => {
    expect(base64ToBytes("a").isErr()).toBe(true);
    expect(base64ToBytes("!!!!").isErr()).toBe(true);
    expect(base64ToBytes("aGVsbG8=" + "ÿ").isErr()).toBe(true);
  });
});

import type { Peer } from "@syncmesh/transport/test-fixtures";

import { peer } from "@syncmesh/transport/test-fixtures";
import { describe, expect, test } from "bun:test";

import type {
  BleAdvertisement,
  BleRadio,
  BleSubscribers,
  BleValueChanged,
  BleWriteRequested,
} from "../radio.js";

import { hintOf } from "../advert.js";
import { base64ToBytes } from "../base64.js";
import { HEADER_BYTES } from "../fragment.js";
import { HELLO, SEALED } from "../handshake.js";
import { bleTransport } from "../transport.js";

const SERVICE = "19d74c40-95d0-4b3c-a4a3-d4a8c8bdfe01";
const CHAR = "19d74c41-95d0-4b3c-a4a3-d4a8c8bdfe01";

/**
 * A radio that records what a device did, and lets a test deliver events to it. Two of these
 * wired together are two phones: one advertises, the other scans and sees it.
 */
const fake = () => {
  const advertised: string[] = [];
  const scans: string[] = [];
  const writes: { connectionId: string; value: string }[] = [];
  const notifies: string[] = [];
  const connected: string[] = [];
  let published = 0;
  const on = {
    scan: new Set<(e: BleAdvertisement) => void>(),
    value: new Set<(e: BleValueChanged) => void>(),
    write: new Set<(e: BleWriteRequested) => void>(),
    subscribers: new Set<(e: BleSubscribers) => void>(),
    connection: new Set<(e: { connectionId: string; state: string }) => void>(),
  };
  const sub = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => void set.delete(cb);
  };
  const radio: BleRadio = {
    startAdvertising: (o) => {
      advertised.push(o.localName ?? "");
      return Promise.resolve();
    },
    stopAdvertising: () => Promise.resolve(),
    publishServices: () => {
      published += 1;
      return Promise.resolve();
    },
    unpublishServices: () => Promise.resolve(),
    startScan: (o) => {
      scans.push(o?.serviceUuids?.[0] ?? "");
      return Promise.resolve();
    },
    stopScan: () => Promise.resolve(),
    connect: (peripheralId) => {
      connected.push(peripheralId);
      return Promise.resolve({ connectionId: `conn-${peripheralId}`, mtu: 185 });
    },
    disconnect: () => Promise.resolve(),
    discoverServices: () => Promise.resolve(),
    subscribe: () => Promise.resolve(),
    write: (connectionId, _s, _c, value) => {
      writes.push({ connectionId, value });
      return Promise.resolve();
    },
    setCharacteristicValue: (_s, _c, value) => {
      notifies.push(value);
      return Promise.resolve();
    },
    requestMtu: (_c, mtu) => Promise.resolve(mtu),
    onScanResult: (cb) => sub(on.scan, cb),
    onConnectionStateChanged: (cb) => sub(on.connection, cb),
    onCharacteristicValueChanged: (cb) => sub(on.value, cb),
    onCharacteristicWriteRequested: (cb) => sub(on.write, cb),
    onSubscribersChanged: (cb) => sub(on.subscribers, cb),
  };
  return {
    radio,
    advertised,
    scans,
    writes,
    notifies,
    connected,
    published: () => published,
    saw: (e: BleAdvertisement) => on.scan.forEach((cb) => cb(e)),
    wrote: (e: BleWriteRequested) => on.write.forEach((cb) => cb(e)),
    notified: (e: BleValueChanged) => on.value.forEach((cb) => cb(e)),
    dropped: (connectionId: string) =>
      on.connection.forEach((cb) => cb({ connectionId, state: "disconnected" })),
  };
};

/** Two granted devices with real engines — `attach` builds a real bridge, so a stub will not do. */
const LOWER = peer(40, "acct_a");
const HIGHER = peer(41, "acct_b");
const lowerFirst = hintOf(LOWER.identity.peerId) < hintOf(HIGHER.identity.peerId);
const [small, large] = lowerFirst ? [LOWER, HIGHER] : [HIGHER, LOWER];

const start = async (radio: BleRadio, who: Peer) => {
  const transport = bleTransport({ radio, serviceUuid: SERVICE, characteristicUuid: CHAR });
  await transport.start(who.context);
  return transport;
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the BLE transport", () => {
  test("opens both roles: publishes, advertises its hint, and scans for the service", async () => {
    const radio = fake();
    await start(radio.radio, small);
    expect(radio.published()).toBe(1);
    expect(radio.advertised).toEqual([hintOf(small.identity.peerId)]);
    expect(radio.scans).toEqual([SERVICE]);
  });

  test("exactly one end dials, and it is the smaller hint", async () => {
    const lower = fake();
    await start(lower.radio, small);
    lower.saw({ peripheralId: "phone-b", localName: hintOf(large.identity.peerId) });
    await settle();
    expect(lower.connected).toEqual(["phone-b"]);

    const higher = fake();
    await start(higher.radio, large);
    higher.saw({ peripheralId: "phone-a", localName: hintOf(small.identity.peerId) });
    await settle();
    // it waits to be written to instead; dialling as well is the deadlock the rule prevents
    expect(higher.connected).toEqual([]);
  });

  test("its own advertisement coming back is not a peer", async () => {
    const radio = fake();
    await start(radio.radio, small);
    radio.saw({ peripheralId: "myself", localName: hintOf(small.identity.peerId) });
    await settle();
    expect(radio.connected).toEqual([]);
  });

  test("a device seen repeatedly is dialled once, not once per advertisement", async () => {
    const radio = fake();
    await start(radio.radio, small);
    for (let i = 0; i < 5; i += 1)
      radio.saw({ peripheralId: "phone-b", localName: hintOf(large.identity.peerId) });
    await settle();
    expect(radio.connected).toEqual(["phone-b"]);
  });

  test("a dialled link writes; a dialled-into link notifies", async () => {
    const dialler = fake();
    await start(dialler.radio, small);
    dialler.saw({ peripheralId: "phone-b", localName: hintOf(large.identity.peerId) });
    await settle();
    // the bridge sends its grants and cursors the moment a link attaches
    expect(dialler.writes.length).toBeGreaterThan(0);
    expect(dialler.notifies).toEqual([]);

    const dialled = fake();
    await start(dialled.radio, large);
    dialled.wrote({
      characteristicUuid: CHAR,
      valueBase64: "AAAAAQAAAAE=",
      centralId: hintOf(small.identity.peerId),
    });
    await settle();
    expect(dialled.notifies.length).toBeGreaterThan(0);
    expect(dialled.writes).toEqual([]);
  });

  test("a dropped connection closes the link rather than leaving it half-open", async () => {
    const radio = fake();
    await start(radio.radio, small);
    radio.saw({ peripheralId: "phone-b", localName: hintOf(large.identity.peerId) });
    await settle();
    const before = radio.writes.length;

    radio.dropped("conn-phone-b");
    await settle();
    // and the same peer advertising again is dialled afresh rather than written to on a dead link
    radio.saw({ peripheralId: "phone-b", localName: hintOf(large.identity.peerId) });
    await settle();
    expect(radio.connected).toEqual(["phone-b", "phone-b"]);
    expect(radio.writes.length).toBeGreaterThan(before);
  });

  test("what goes on the air is a hello and then ciphertext, never a readable frame", async () => {
    const radio = fake();
    await start(radio.radio, small);
    radio.saw({ peripheralId: "phone-b", localName: hintOf(large.identity.peerId) });
    await settle();

    // the negotiated MTU leaves room for a whole handshake frame, so one packet is one frame
    const kinds = radio.writes.map((w) => base64ToBytes(w.value).unwrap()[HEADER_BYTES]);
    expect(kinds[0]).toBe(HELLO);
    // the bridge's grants and cursors are held until the session opens, so nothing else is bare
    expect(kinds.slice(1).every((kind) => kind === SEALED || kind === undefined)).toBe(true);
  });

  test("someone else's advertisement is ignored entirely", async () => {
    const radio = fake();
    await start(radio.radio, small);
    radio.saw({ peripheralId: "headphones", localName: "AirPods" });
    await settle();
    expect(radio.connected).toEqual([]);
  });
});

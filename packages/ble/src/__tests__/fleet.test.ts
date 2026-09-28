import { peer } from "@syncmesh/transport/test-fixtures";
import { describe, expect, test } from "bun:test";

import type { BleRadio } from "../radio.js";

import { hintOf } from "../advert.js";
import { virtualAir } from "../testing/virtual-air.js";
import { bleTransport } from "../transport.js";

const SERVICE = "19d74c40-95d0-4b3c-a4a3-d4a8c8bdfe01";
const CHAR = "19d74c41-95d0-4b3c-a4a3-d4a8c8bdfe01";

/**
 * The one cheap refusal BLE has room for (book ch. 17).
 *
 * Every other medium refuses on a peer id it was told. Ten bytes of advertisement cannot carry
 * one, so what this medium can ask is the narrower question — *is this one of ours?* — and the
 * cost of not asking it is a connection, a subscription, an MTU negotiation and a handshake,
 * on the slowest radio a device has.
 */

/** A radio that records whether anything ever asked it to connect. */
const counting = (radio: BleRadio) => {
  let connects = 0;
  return {
    connects: () => connects,
    radio: {
      ...radio,
      connect: async (peripheralId: string) => {
        connects += 1;
        return radio.connect(peripheralId);
      },
    } satisfies BleRadio,
  };
};

/**
 * Two devices in one room. Which of them dials is `shouldDial`'s to decide from their hints, so
 * both radios are counted and the question asked of the pair: was a connection spent at all?
 */
const open = async (ours: string, theirs: string) => {
  const air = virtualAir();
  const [a, b] = [peer(40, "acct_a"), peer(80, "acct_b")];
  const names = [hintOf(a.identity.peerId), hintOf(b.identity.peerId)];
  const radios = [
    counting(air.radioFor(names[0] ?? "a", [names[1] ?? "b"])),
    counting(air.radioFor(names[1] ?? "b", [names[0] ?? "a"])),
  ];
  const source = bleTransport({
    radio: radios[0]!.radio,
    serviceUuid: SERVICE,
    characteristicUuid: CHAR,
    name: "ble:a",
    ...(ours !== "" && { group: ours }),
  });
  const other = bleTransport({
    radio: radios[1]!.radio,
    serviceUuid: SERVICE,
    characteristicUuid: CHAR,
    name: "ble:b",
    ...(theirs !== "" && { group: theirs }),
  });
  await Promise.all([source.start(a.context), other.start(b.context)]);
  for (let round = 0; round < 6; round += 1) {
    await air.settle();
    await source.flush?.();
    await other.flush?.();
  }
  const connects = () => radios.reduce((total, radio) => total + radio.connects(), 0);
  return { connects, source, other };
};

describe("a fleet tag is what BLE can refuse on before it connects", () => {
  test("another fleet's phone costs nothing: no connection, no handshake", async () => {
    const room = await open("the-ward", "the-depot");
    expect(room.connects()).toBe(0);
    expect(room.source.reaches?.().size).toBe(0);
    await room.source.stop();
    await room.other.stop();
  });

  test("our own fleet is dialled, so the refusal is about the group and not the wiring", async () => {
    const room = await open("the-ward", "the-ward");
    expect(room.connects()).toBeGreaterThan(0);
    expect(room.source.reaches?.().size).toBe(1);
    await room.source.stop();
    await room.other.stop();
  });

  test("a device that names no fleet dials everything, as it always did", async () => {
    const room = await open("", "the-depot");
    expect(room.connects()).toBeGreaterThan(0);
    await room.source.stop();
    await room.other.stop();
  });

  test("a peer that names no fleet is dialled, not refused — absent is abstain", async () => {
    // an older build advertises no group, and a platform may drop service data entirely;
    // refusing on a field that did not arrive would make a fleet invisible to itself
    const room = await open("the-ward", "");
    expect(room.connects()).toBeGreaterThan(0);
    await room.source.stop();
    await room.other.stop();
  });
});

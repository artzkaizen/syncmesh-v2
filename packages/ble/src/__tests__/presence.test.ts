import type { Transport } from "@syncmesh/transport";

import { column, row } from "@syncmesh/kernel/test-fixtures";
import { createPresenceStore } from "@syncmesh/transport";
import { ACME, T0, bodyOf, peer, write } from "@syncmesh/transport/test-fixtures";
import { decodeAndVerifyPresence, signPresence } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { BleRadio } from "../radio.js";

import { hintOf } from "../advert.js";
import { virtualAir } from "../testing/virtual-air.js";
import { bleTransport } from "../transport.js";

/**
 * Presence over a radio that cannot keep up (E19): a cursor set at pointer rate on a link that
 * carries a fraction of that, with events competing for the same air.
 *
 * The clock is explicit — every set advances it by one 60 Hz frame — so "three seconds" is 180
 * sets and costs only the turns it takes to deliver them.
 */

const SERVICE = "19d74c40-95d0-4b3c-a4a3-d4a8c8bdfe01";
const CHAR = "19d74c41-95d0-4b3c-a4a3-d4a8c8bdfe01";
const HZ = 60;
const SETS = 3 * HZ;
/** The radio puts one packet on the air per this many sets: a link a few times slower than the pointer. */
const SETS_PER_PACKET = 3;
const TTL_MS = 30_000;

/** A radio whose writes leave only as fast as the test lets them — a busy BLE connection interval. */
const throttled = (radio: BleRadio) => {
  let open = true;
  const waiting: (() => void)[] = [];
  const gate =
    <A extends unknown[]>(put: (...args: A) => Promise<void>) =>
    (...args: A): Promise<void> =>
      open ? put(...args) : new Promise<void>((go) => waiting.push(go)).then(() => put(...args));
  return {
    radio: {
      ...radio,
      write: gate(radio.write),
      setCharacteristicValue: gate(radio.setCharacteristicValue),
    } satisfies BleRadio,
    throttle: () => void (open = false),
    /** One packet's worth of air: the oldest write waiting leaves. */
    carry: () => waiting.shift()?.(),
    open: () => {
      open = true;
      for (const go of waiting.splice(0)) go();
    },
  };
};

/** Seeded, so a run that loses a packet at an awkward moment loses it again on replay. */
const seeded = (state: number) => () => {
  state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
  return state / 2 ** 31;
};

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Two phones in range: `a` sets a cursor through a throttled radio, `b` keeps what arrives. */
const pair = async () => {
  const air = virtualAir(185, { random: seeded(19) });
  const a = peer(40, "acct_a");
  const b = peer(80, "acct_b");
  const names = [hintOf(a.identity.peerId), hintOf(b.identity.peerId)];
  const sender = throttled(air.radioFor(names[0] ?? "a", [names[1] ?? "b"]));
  let elapsedMs = 0;
  const now = () => T0.add({ milliseconds: elapsedMs });
  /** The receiver's last value per `(topic, instance, peer)` — the store every hop uses. */
  const seen = createPresenceStore({ now });
  let arrived = 0;
  const onPresence = (wire: Uint8Array) => {
    arrived += 1;
    const verified = decodeAndVerifyPresence(wire);
    if (verified.isOk()) seen.admit(verified.value);
  };
  const transports: readonly Transport[] = [
    bleTransport({
      radio: sender.radio,
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      name: "ble:a",
    }),
    bleTransport({
      radio: air.radioFor(names[1] ?? "b", [names[0] ?? "a"]),
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      name: "ble:b",
    }),
  ];
  await Promise.all([
    transports[0]?.start(a.context),
    transports[1]?.start({ ...b.context, onPresence }),
  ]);
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) {
      await air.settle();
      for (const transport of transports) await transport.flush?.();
    }
  };
  await settle();

  let count = 0;
  /** `a` moves its cursor to `x`: one signed value, a 60 Hz frame later than the last. */
  const set = (x: number) => {
    count += 1;
    elapsedMs = Math.round((count * 1000) / HZ);
    const signed = signPresence(
      {
        v: 1,
        peerId: a.identity.peerId,
        topic: "cursor",
        partition: ACME,
        session: "burst",
        count,
        value: row({ x }),
        expires: now().epochMilliseconds + TTL_MS,
      },
      a.identity,
    );
    transports[0]?.sendPresence?.(signed.wire);
  };
  const cursor = () => seen.peers("cursor", ACME)[0]?.value.get(column("x"));
  return {
    a,
    b,
    air,
    sender,
    seen,
    set,
    cursor,
    settle,
    arrived: () => arrived,
    resync: () => transports.forEach((t) => t.resync?.()),
    stop: () => Promise.all(transports.map((t) => t.stop())),
  };
};

describe("the 60 Hz burst (E19)", () => {
  test("a slow link carries the current cursor, a fraction of the sets, and never a backlog", async () => {
    const room = await pair();
    room.sender.throttle();
    for (let x = 1; x <= SETS; x += 1) {
      room.set(x);
      if (x % SETS_PER_PACKET === 0) room.sender.carry();
      await turn();
    }
    const during = room.arrived();
    // conflated at the sender: the radio carried what it could, and what it could is far less
    expect(during).toBeGreaterThan(5);
    expect(during).toBeLessThan(SETS / 4);

    // the pointer stops; what is still owed is the newest value, not three seconds of old ones
    room.sender.open();
    await room.settle();
    expect(room.arrived() - during).toBeLessThanOrEqual(2);
    expect(room.cursor()).toBe(SETS);

    // bounded at the receiver too: one value for the one peer, and nothing ever touched a log
    expect(room.seen.size()).toBe(1);
    expect(room.a.engine.coverage().synced.size).toBe(0);
    expect(room.b.engine.coverage().synced.size).toBe(0);
    await room.stop();
  });
});

describe("a BLE-shaped drop (E19, RFC-0012 §2)", () => {
  test("presence yields to events on a busy, lossy radio, and a lost value is superseded", async () => {
    const room = await pair();
    const notes = ["n30", "n60", "n90", "n120", "n150"];
    room.sender.throttle();
    for (let x = 1; x <= SETS; x += 1) {
      room.set(x);
      if (notes.includes(`n${x}`)) (await write(room.a, `n${x}`, `written at ${x}`)).unwrap();
      if (x % SETS_PER_PACKET === 0) room.sender.carry();
      await turn();
    }
    // every event crossed while the cursor was still moving: none of them waited behind presence
    for (const id of notes) expect(bodyOf(room.b, id)).toBeDefined();
    expect(room.arrived()).toBeLessThan(SETS / 4);
    room.sender.open();
    await room.settle();
    expect(room.cursor()).toBe(SETS);

    // the next value's first packet vanishes: that value never arrives, and nothing asks for it
    room.air.drop(1);
    room.set(SETS + 1);
    await room.settle();
    expect(room.cursor()).toBe(SETS);
    room.set(SETS + 2);
    await room.settle();
    expect(room.cursor()).toBe(SETS + 2);

    // interference: events and presence both lose packets; the events are recovered, the cursor
    // is simply whatever arrived last
    room.air.setLoss(0.3);
    const late = ["l1", "l2", "l3"];
    for (const [at, id] of late.entries()) {
      room.set(SETS + 3 + at);
      (await write(room.a, id, "under loss")).unwrap();
      await room.settle();
    }
    room.air.setLoss(0);
    room.resync();
    await room.settle();
    for (const id of [...notes, ...late]) expect(bodyOf(room.b, id)).toBeDefined();
    room.set(SETS + 10);
    await room.settle();
    expect(room.cursor()).toBe(SETS + 10);
    expect(room.seen.size()).toBe(1);
    await room.stop();
  });
});

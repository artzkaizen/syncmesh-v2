import type { Severable } from "@syncmesh/transport/transport-tests";

import { parsePartitionKey, readRow } from "@syncmesh/kernel";
import { severable, suitePeers } from "@syncmesh/transport/transport-tests";
import { expect, test } from "bun:test";

import type { BleRadio } from "../radio.js";

import { hintOf } from "../advert.js";
import { virtualAir } from "../testing/virtual-air.js";
import { bleTransport } from "../transport.js";

/**
 * One phone's Bluetooth switched off and on again, with the other phone left alone.
 *
 * **This is the case the fixture never covered and the one people actually hit.** The suite's
 * severance takes the whole air away and gives it back, so every device restarts together and
 * every session is replaced on both sides at once. A person toggling Control Centre on one handset
 * produces something different and much worse: the device that cycled loses everything, and its
 * neighbour is told *nothing at all* — no disconnect, no close — so it goes on holding a session
 * keyed to an ephemeral secret that no longer exists anywhere. Both phones then report a healthy
 * radio and exchange nothing, for as long as they are both switched on.
 *
 * Kept asymmetric on purpose. A version of this where both adapters cycle passes against code
 * that cannot recover from the real thing.
 */

const SERVICE = "19d74c40-95d0-4b3c-a4a3-d4a8c8bdfe01";
const CHAR = "19d74c41-95d0-4b3c-a4a3-d4a8c8bdfe01";
const ACME = parsePartitionKey("org:acme").unwrap();

/** One device's radio, with a switch that takes its links away the way a real adapter does. */
const adapterOf = (radio: BleRadio, medium: Severable) => {
  const links = new Map<string, () => boolean>();
  const carries = (connectionId: string): boolean =>
    links.get(connectionId)?.() ?? medium.carrying();
  const powered = new Set<(state: string) => void>();
  let notifying = medium.linked();
  return {
    off: () => {
      medium.sever();
      powered.forEach((cb) => cb("poweredOff"));
    },
    on: () => {
      medium.restore();
      notifying = medium.linked();
      powered.forEach((cb) => cb("poweredOn"));
    },
    radio: {
      ...radio,
      startAdvertising: (options) =>
        medium.carrying() ? radio.startAdvertising(options) : Promise.resolve(),
      publishServices: (spec) =>
        medium.carrying() ? radio.publishServices(spec) : Promise.resolve(),
      startScan: (options) => (medium.carrying() ? radio.startScan(options) : Promise.resolve()),
      connect: (peripheralId) =>
        medium.carrying()
          ? radio.connect(peripheralId).then((connected) => {
              links.set(connected.connectionId, medium.linked());
              return connected;
            })
          : Promise.reject(new Error(`${peripheralId} is unreachable: the adapter is off`)),
      disconnect: (connectionId) =>
        carries(connectionId) ? radio.disconnect(connectionId) : Promise.resolve(),
      discoverServices: (connectionId) =>
        carries(connectionId) ? radio.discoverServices(connectionId) : Promise.resolve(),
      subscribe: (connectionId, serviceUuid, characteristicUuid) =>
        carries(connectionId)
          ? radio.subscribe(connectionId, serviceUuid, characteristicUuid)
          : Promise.resolve(),
      write: (connectionId, serviceUuid, characteristicUuid, valueBase64, writeType) =>
        carries(connectionId)
          ? radio.write(connectionId, serviceUuid, characteristicUuid, valueBase64, writeType)
          : Promise.resolve(),
      setCharacteristicValue: (serviceUuid, characteristicUuid, valueBase64, notify) =>
        notifying()
          ? radio.setCharacteristicValue(serviceUuid, characteristicUuid, valueBase64, notify)
          : Promise.resolve(),
      onScanResult: (cb) =>
        radio.onScanResult((event) => {
          if (medium.carrying()) cb(event);
        }),
      onConnectionStateChanged: (cb) =>
        radio.onConnectionStateChanged((event) => {
          if (carries(event.connectionId)) cb(event);
        }),
      onCharacteristicValueChanged: (cb) =>
        radio.onCharacteristicValueChanged((event) => {
          if (carries(event.connectionId)) cb(event);
        }),
      onCharacteristicWriteRequested: (cb) =>
        radio.onCharacteristicWriteRequested((event) => {
          if (medium.carrying()) cb(event);
        }),
      onSubscribersChanged: (cb) =>
        radio.onSubscribersChanged((event) => {
          if (!medium.carrying()) return;
          notifying = medium.linked();
          cb(event);
        }),
      onAdapterStateChanged: (cb) => {
        powered.add(cb);
        return () => void powered.delete(cb);
      },
    } satisfies BleRadio,
  };
};

test("one phone's radio cycles and the pair converges again", async () => {
  const [alice, bob] = suitePeers();
  const air = virtualAir();
  const names = [hintOf(alice.identity.peerId), hintOf(bob.identity.peerId)];

  // only Alice's adapter can be switched; Bob's is never touched, which is the point
  const aliceRadio = adapterOf(air.radioFor(names[0] ?? "a", [names[1] ?? "b"]), severable());
  const bobRadio = air.radioFor(names[1] ?? "b", [names[0] ?? "a"]);

  const transports = [
    bleTransport({
      radio: aliceRadio.radio,
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      name: "ble:alice",
      keepaliveMs: 60,
    }),
    bleTransport({
      radio: bobRadio,
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      name: "ble:bob",
      keepaliveMs: 60,
    }),
  ];
  await Promise.all([transports[0]?.start(alice), transports[1]?.start(bob)]);

  const settle = async (ms = 0) => {
    const until = Date.now() + ms;
    do {
      for (let round = 0; round < 8; round += 1) {
        await air.settle();
        for (const transport of transports) await transport.flush?.();
      }
      if (ms > 0) {
        await new Promise((go) => setTimeout(go, 20));
        // a handset's controller re-emits constantly; a scanner that was busy a moment ago is
        // exactly the one that needs to hear it again
        air.readvertise();
      }
    } while (Date.now() < until);
  };
  /*
   * SAFETY: `notes` is the table the suite's peers are built over and `id`/`body` are its two
   * columns, so every assertion below names a real member of this fixture's schema. They are
   * `never` because `SuitePeer`'s engine is typed over the suite's schema generically rather than
   * over this one, which is a gap in the fixture's types and not a claim being made about the data.
   */
  const put = async (who: typeof alice, id: string, body: string) =>
    (
      await who.engine.mutate(
        "notes.create" as never,
        (tx) =>
          tx.insert(
            "notes" as never,
            id as never,
            new Map([
              ["id" as never, id],
              ["body" as never, body],
            ]),
          ),
        { partition: ACME },
      )
    ).unwrap();
  // SAFETY: the same table and columns as `put` above, read back
  const bodyOf = (who: typeof alice, id: string) =>
    readRow(who.engine.state(), "notes" as never, id as never)?.get("body" as never);

  await settle();
  await put(alice, "before", "before");
  await settle();
  expect(bodyOf(bob, "before")).toBe("before");

  // Control Centre off, then on. Bob is told nothing by anyone.
  aliceRadio.off();
  await settle();
  aliceRadio.on();
  await settle();
  await settle();

  // the write that has to cross the re-established link
  await put(alice, "after", "after");
  await settle(300);

  expect(bodyOf(bob, "after")).toBe("after");
  // and the other direction, which is the half a stale session strands
  await put(bob, "back", "back");
  await settle(300);
  expect(bodyOf(alice, "back")).toBe("back");

  await Promise.all(transports.map((t) => t.stop()));
}, 30_000);

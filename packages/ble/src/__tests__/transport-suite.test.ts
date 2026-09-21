import type { Connect, Severable, SuiteNetwork } from "@syncmesh/transport/transport-tests";

import { severable, suitePeers, transportTests } from "@syncmesh/transport/transport-tests";
import { describe, expect, test } from "bun:test";

import type { BleRadio } from "../radio.js";

import { hintOf } from "../advert.js";
import { virtualAir } from "../testing/virtual-air.js";
import { bleTransport } from "../transport.js";

const SERVICE = "19d74c40-95d0-4b3c-a4a3-d4a8c8bdfe01";
const CHAR = "19d74c41-95d0-4b3c-a4a3-d4a8c8bdfe01";

/**
 * The Bluetooth adapter, between a real `bleTransport` and the virtual air — the thing a person
 * switches off in Settings while the app is open.
 *
 * Off, it advertises nothing, hears nothing, opens no connection, and carries nothing over the
 * connections it already had. What it never does is report any of that *per link*: no
 * disconnect, no failed write, no close. From the stack's point of view nothing happened to any
 * link — the medium simply stopped existing, which is why the transport above goes on holding
 * links that are already gone.
 *
 * It does say one thing, because a real adapter says exactly one thing:
 * {@link BleRadio.onAdapterStateChanged}. That is a fact about the radio and not about anybody's
 * connection, CoreBluetooth really does deliver it, and it is the only thread this transport has
 * to pull. A fixture that stayed silent here would be modelling a platform that does not exist.
 *
 * The connections held when it went stay dead after it comes back, which is what a GATT
 * connection does: cycling the adapter takes every one of them with it, and only a fresh dial
 * reaches that peripheral again.
 *
 * Every method delegates rather than awaiting. An `async` wrapper here adds a microtask to every
 * platform call, and enough of those slip past what `air.settle()` drains — a chain that links up
 * without the wrapper then fails to, which is the fixture's timing and not the transport's.
 */
const adapterOf = (radio: BleRadio, medium: Severable) => {
  /** Per connection, whether *that* connection still carries; a dial after a severance is new. */
  const links = new Map<string, () => boolean>();
  const carries = (connectionId: string): boolean =>
    links.get(connectionId)?.() ?? medium.carrying();
  const powered = new Set<(state: string) => void>();
  /**
   * The peripheral half of the same fact. A notification names no connection, so what stands in
   * for one is the subscriber list: an adapter that cycled holds no subscribers until a central
   * subscribes again, and until then its notifications go to nobody. A fresh subscription is a
   * fresh link, which is why this is re-taken rather than set back.
   */
  let notifying = medium.linked();
  return {
    /** This adapter is switched off: its links die where they stand, and it says only this. */
    off: () => {
      medium.sever();
      powered.forEach((cb) => cb("poweredOff"));
    },
    /** And on again — in that order, so what `poweredOn` sets off runs over a radio that carries. */
    on: () => {
      medium.restore();
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
      // accepted and carried nowhere rather than rejected: a write this radio never put in the
      // air is one nothing above it can hear about, which is the whole of the defect
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

/**
 * The transport contract, over BLE, with three real `bleTransport`s on one virtual air.
 *
 * Everything else in this package tests a piece against a fake that answers it. This runs the
 * suite every transport runs, which means the dial rule, the fragmenting, the session handshake
 * and the bridge are all exercised at once, by a peer that is itself a `bleTransport` rather than
 * a test pretending to be one.
 *
 * A chain rather than a room: each device hears only its neighbours, so the outer two can only
 * reach each other through the middle. That is the topology that catches a hop which quietly
 * stops forwarding — the failure a pair can never show.
 */
const openChain = async (peers: Parameters<Connect>[0]) => {
  const air = virtualAir();
  const names = peers.map((peer) => hintOf(peer.identity.peerId));
  // one medium per device, because a radio is per device: Bluetooth switched off on a phone is
  // that phone's links gone, and the phone it was talking to keeps a radio that is working fine
  const adapters = peers.map((_peer, i) => {
    const neighbours = [names[i - 1], names[i + 1]].filter((n): n is string => n !== undefined);
    return adapterOf(air.radioFor(names[i] ?? String(i), neighbours), severable());
  });
  const transports = adapters.map((adapter, i) =>
    bleTransport({
      radio: adapter.radio,
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      name: `ble:${i}`,
    }),
  );
  await Promise.all(transports.map((transport, i) => transport.start(peers[i]!)));

  const network = {
    settle: async () => {
      // more rounds than a loopback needs: a BLE frame is fragments, and a session opens with a
      // handshake before the bridge has said anything at all
      for (let round = 0; round < 6; round += 1) {
        await air.settle();
        for (const transport of transports) await transport.flush?.();
      }
    },
    stop: async () => {
      await Promise.all(transports.map((transport) => transport.stop()));
    },
    wake: () => transports.forEach((transport) => transport.wake?.()),
    chaos: {
      drop: (count: number) => air.drop(count),
      resyncAll: () => transports.forEach((transport) => transport.resync?.()),
      /**
       * Bluetooth goes off on every device at once. Every link dies where it stands and not one
       * of them is reported; the only thing said is what the platform says, which is that the
       * adapter's own state changed.
       */
      sever: () => {
        for (const adapter of adapters) adapter.off();
      },
      /** Every adapter is switched back on, each of them as quiet about it as the platform is. */
      restore: () => {
        for (const adapter of adapters) adapter.on();
      },
    },
  } satisfies SuiteNetwork;
  return { transports, network };
};

const connectOverBle: Connect = async (peers) => (await openChain(peers)).network;

describe("BLE runs the transport contract", () => {
  for (const suiteCase of transportTests(connectOverBle)) test(suiteCase.name, suiteCase.run);
});

describe("a radio says which peers it reaches (E28)", () => {
  test("a peer appears once its handshake proves it, and only its own neighbours do", async () => {
    const peers = suitePeers();
    const [a, b, c] = peers;
    const { transports, network } = await openChain(peers);
    await network.settle();
    const reached = (i: number) => transports[i]?.reaches?.();

    // the chain's own topology, read back off the radios: the middle reaches both ends, and
    // neither end reaches the other — which is the whole reason a chain catches a bad hop
    expect(reached(1)).toEqual(new Set([a.identity.peerId, c.identity.peerId]));
    expect(reached(0)).toEqual(new Set([b.identity.peerId]));
    expect(reached(2)).toEqual(new Set([b.identity.peerId]));
    // proven, not hinted: an end never claims the peer it only hears of through the middle
    expect(reached(0)?.has(c.identity.peerId)).toBe(false);

    await network.stop();
  });

  test("stopping the radio takes its peers with it", async () => {
    const { transports, network } = await openChain(suitePeers());
    await network.settle();
    expect(transports[1]?.reaches?.().size).toBe(2);

    await network.stop();
    expect(transports[1]?.reaches?.().size).toBe(0);
  });
});

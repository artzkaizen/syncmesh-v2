import type { Connect } from "@syncmesh/transport/transport-tests";

import { transportTests } from "@syncmesh/transport/transport-tests";
import { describe, test } from "bun:test";

import { hintOf } from "../advert.js";
import { bleTransport } from "../transport.js";
import { virtualAir } from "./virtual-air.js";

const SERVICE = "19d74c40-95d0-4b3c-a4a3-d4a8c8bdfe01";
const CHAR = "19d74c41-95d0-4b3c-a4a3-d4a8c8bdfe01";

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
const connectOverBle: Connect = async (peers) => {
  const air = virtualAir();
  const names = peers.map((peer) => hintOf(peer.identity.peerId));
  const transports = peers.map((_peer, i) => {
    const neighbours = [names[i - 1], names[i + 1]].filter((n): n is string => n !== undefined);
    return bleTransport({
      radio: air.radioFor(names[i] ?? String(i), neighbours),
      serviceUuid: SERVICE,
      characteristicUuid: CHAR,
      name: `ble:${i}`,
    });
  });
  await Promise.all(transports.map((transport, i) => transport.start(peers[i]!)));

  return {
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
    chaos: {
      drop: (count) => air.drop(count),
      resyncAll: () => transports.forEach((transport) => transport.resync?.()),
    },
  };
};

describe("BLE runs the transport contract", () => {
  for (const suiteCase of transportTests(connectOverBle)) test(suiteCase.name, suiteCase.run);
});

import type { LanAddress } from "@syncmesh/transports";

import { suitePeers } from "@syncmesh/transport/transport-tests";
import { lan } from "@syncmesh/transports";
import { describe, expect, test } from "bun:test";

import { nodeLan } from "../index.js";

/**
 * Two devices on the loopback, over real sockets.
 *
 * Multicast is not exercised: whether an access point carries it is a fact about the room and
 * not about this code, and a test that depended on it would fail on the networks where the
 * `seeds` path exists precisely because it does not. What is exercised is everything else —
 * a datagram that finds a peer, a dialled TCP connection, the handshake across it, and a mesh
 * that converges over the pair.
 */

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the LAN network on Node's sockets", () => {
  test("two devices find each other by datagram and link over TCP", async () => {
    const peers = suitePeers();
    // where each side announces, filled in once both sockets exist and can say where they are
    let seedsForA: readonly LanAddress[] = [];
    let seedsForB: readonly LanAddress[] = [];
    const netA = (
      await nodeLan({ host: "127.0.0.1", multicast: false, seeds: () => seedsForA })
    ).unwrap();
    const netB = (
      await nodeLan({ host: "127.0.0.1", multicast: false, seeds: () => seedsForB })
    ).unwrap();

    // each announces straight at the other's discovery socket, which is what a network that
    // drops multicast between its clients leaves you with
    seedsForA = [netB.discoveryAddress()];
    seedsForB = [netA.discoveryAddress()];

    const a = lan({ id: "loopback", network: netA, name: "lan:a", announceEveryMs: 20 });
    const b = lan({ id: "loopback", network: netB, name: "lan:b", announceEveryMs: 20 });
    await a.start(peers[0]);
    await b.start(peers[1]);

    for (let round = 0; round < 25 && (a.reaches?.().size ?? 0) === 0; round += 1) await settle(20);
    expect(a.reaches?.()).toEqual(new Set([peers[1].identity.peerId]));
    expect(b.reaches?.()).toEqual(new Set([peers[0].identity.peerId]));

    await a.stop();
    await b.stop();
  });

  test("a dial at nothing fails as a value, rather than as an unhandled socket error", async () => {
    const network = (await nodeLan({ host: "127.0.0.1", multicast: false })).unwrap();
    // port 1 on the loopback: privileged, and nothing this test started is listening there
    expect(network.dial({ host: "127.0.0.1", port: 1 })).rejects.toThrow();
    await network.close();
  });

  test("a connection that is closed says the bytes did not leave, rather than swallowing them", async () => {
    const server = (await nodeLan({ host: "127.0.0.1", multicast: false })).unwrap();
    const client = (await nodeLan({ host: "127.0.0.1", multicast: false })).unwrap();
    const stream = await client.dial({ host: "127.0.0.1", port: server.address().port });
    stream.close();
    await settle(10);

    expect(() => stream.write(Uint8Array.of(1, 2, 3))).toThrow("did not leave");

    await server.close();
    await client.close();
  });
});

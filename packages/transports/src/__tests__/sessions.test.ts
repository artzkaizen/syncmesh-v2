import type { SuitePeer } from "@syncmesh/transport/transport-tests";

import { createPeerSessions } from "@syncmesh/transport";
import { suitePeers } from "@syncmesh/transport/transport-tests";
import { describe, expect, test } from "bun:test";

import { lan } from "../lan/transport.js";
import { virtualLan } from "../lan/virtual-lan.js";
import { wifiAware } from "../p2p/transport.js";
import { virtualFabric } from "../p2p/virtual-fabric.js";

/**
 * Two media, two devices, one conversation (book ch. 16).
 *
 * The point of a peer session is only visible with two real transports running side by side to
 * the same peer, which is why this test lives where both are reachable. What it asserts is not
 * that sync works — the contract suite covers that on each medium — but that running two of them
 * is one session with two links rather than two of everything.
 */

const ROOM = "the-ward";

const bothMedia = (peers: readonly SuitePeer[]) => {
  const air = virtualFabric();
  const room = virtualLan();
  const sessions = peers.map(() => createPeerSessions());
  const built = peers.map((_peer, i) => ({
    wifi: wifiAware({ id: ROOM, fabric: air.fabricFor(`d${i}`, "wifi-aware"), name: `wifi:${i}` }),
    lan: lan({ id: ROOM, network: room.networkFor(`d${i}`), name: `lan:${i}` }),
  }));

  const settle = async () => {
    for (let round = 0; round < 8; round += 1) {
      await air.settle();
      await room.settle();
      for (const pair of built) {
        await pair.wifi.flush?.();
        await pair.lan.flush?.();
      }
    }
  };

  const start = async () => {
    await Promise.all(
      built.flatMap((pair, i) => {
        // the context a mesh hands every transport on one device: one session table between them
        const ctx = { ...peers[i]!, sessions: sessions[i]! };
        return [pair.wifi.start(ctx), pair.lan.start(ctx)];
      }),
    );
  };

  return { air, room, built, sessions, start, settle };
};

describe("one peer, two media, one session", () => {
  test("both links join the same conversation, and each medium still names the peer itself", async () => {
    const peers = suitePeers().slice(0, 2);
    const both = bothMedia(peers);
    await both.start();
    await both.settle();

    const [a, b] = both.sessions;
    expect(a?.peers()).toEqual([peers[1]!.identity.peerId]);
    expect(b?.peers()).toEqual([peers[0]!.identity.peerId]);
    // two links, one session — and the session can say which media are carrying it
    expect([...(a?.get(peers[1]!.identity.peerId)?.carriers() ?? [])].sort()).toEqual([
      "lan:0",
      "wifi:0",
    ]);

    // each transport still answers for its own links, which is what `$status` reads
    expect(both.built[0]?.wifi.reaches?.().size).toBe(1);
    expect(both.built[0]?.lan.reaches?.().size).toBe(1);

    await Promise.all(both.built.flatMap((pair) => [pair.wifi.stop(), pair.lan.stop()]));
  });

  test("a medium going away leaves the conversation standing on the other", async () => {
    const peers = suitePeers().slice(0, 2);
    const both = bothMedia(peers);
    await both.start();
    await both.settle();
    const session = both.sessions[0]?.get(peers[1]!.identity.peerId);
    expect(session?.carriers()).toHaveLength(2);

    // the Wi-Fi Aware radio is turned off on both devices; the access point is untouched
    await Promise.all(both.built.map((pair) => pair.wifi.stop()));
    await both.settle();

    // the same session, one link lighter — not a new one, and not a closed one
    expect(both.sessions[0]?.get(peers[1]!.identity.peerId)).toBe(session);
    expect(session?.carriers()).toEqual(["lan:0"]);

    await Promise.all(both.built.map((pair) => pair.lan.stop()));
    await both.settle();
    // and with the last link gone the conversation is over, to be rebuilt from cursors
    expect(both.sessions[0]?.peers()).toEqual([]);
  });
});

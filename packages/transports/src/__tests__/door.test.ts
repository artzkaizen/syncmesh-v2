import type { AdmissionAsk } from "@syncmesh/transport";
import type { SuitePeer } from "@syncmesh/transport/transport-tests";

import { createPeerSessions, oneSeatPerPeer } from "@syncmesh/transport";
import { suitePeers } from "@syncmesh/transport/transport-tests";
import { describe, expect, test } from "bun:test";

import { lan } from "../lan/transport.js";
import { virtualLan } from "../lan/virtual-lan.js";
import { wifiAware } from "../p2p/transport.js";
import { virtualFabric } from "../p2p/virtual-fabric.js";

/**
 * The door, asked through two real media at once (book ch. 14).
 *
 * What matters is the *seat*: a device reachable over the access point and over peer-to-peer
 * Wi-Fi is one conversation, so it is one decision. Asking per link would let two answers
 * disagree about the same peer, and the second one to arrive would win by accident.
 */

const ROOM = "the-ward";

const openRoom = (peers: readonly SuitePeer[], admits: (ask: AdmissionAsk) => Promise<boolean>) => {
  const air = virtualFabric();
  const room = virtualLan();
  const asked: AdmissionAsk[] = [];
  const sessions = peers.map(() => createPeerSessions());
  const built = peers.map((_peer, i) => ({
    wifi: wifiAware({
      id: ROOM,
      fabric: air.fabricFor(`d${String(i)}`, "wifi-aware"),
      name: `wifi:${String(i)}`,
    }),
    lan: lan({ id: ROOM, network: room.networkFor(`d${String(i)}`), name: `lan:${String(i)}` }),
  }));

  const start = async () => {
    await Promise.all(
      built.flatMap((pair, i) => {
        // every device has its own door over its own sessions, as a mesh gives each one
        const ctx = {
          ...peers[i]!,
          sessions: sessions[i]!,
          // the seat is the door's own property — the mesh wraps its gate in exactly this
          admits: oneSeatPerPeer(
            async (ask: AdmissionAsk) => {
              asked.push(ask);
              return admits(ask);
            },
            (peer) => sessions[i]?.get(peer) !== undefined,
          ),
        };
        return [pair.wifi.start(ctx), pair.lan.start(ctx)];
      }),
    );
  };
  const settle = async () => {
    for (let round = 0; round < 10; round += 1) {
      await air.settle();
      await room.settle();
      for (const pair of built) {
        await pair.wifi.flush?.();
        await pair.lan.flush?.();
      }
    }
  };
  const stop = async () => {
    await Promise.all(built.flatMap((pair) => [pair.wifi.stop(), pair.lan.stop()]));
  };
  return { asked, built, sessions, start, settle, stop };
};

describe("the door is one seat per peer, not one per link", () => {
  test("two media reaching one peer is one question", async () => {
    const peers = suitePeers().slice(0, 2);
    const room = openRoom(peers, async () => true);
    await room.start();
    await room.settle();

    // one ask per device about the other, and not one per medium
    const proven = room.asked.filter((ask) => ask.stage !== "dial");
    expect(proven).toHaveLength(2);
    expect(new Set(proven.map((ask) => ask.peer)).size).toBe(2);
    // both media are carrying it: the answer was about the peer, not about the medium
    expect(room.sessions[0]?.get(peers[1]!.identity.peerId)?.carriers()).toHaveLength(2);

    await room.stop();
  });

  test("the cheap rung refuses before a socket is spent", async () => {
    const peers = suitePeers().slice(0, 2);
    const room = openRoom(peers, async (ask) => ask.stage !== "dial");
    await room.start();
    await room.settle();

    // refused at the announcement, so no handshake was ever negotiated and no session exists
    expect(room.asked.some((ask) => ask.stage === "dial")).toBe(true);
    expect(room.sessions[0]?.peers()).toEqual([]);
    await room.stop();
  });

  test("a denial opens no conversation, on any medium", async () => {
    const peers = suitePeers().slice(0, 2);
    const room = openRoom(peers, async () => false);
    await room.start();
    await room.settle();

    expect(room.asked.length).toBeGreaterThanOrEqual(1);
    // not one link closed and one left standing: no conversation was opened on either device
    expect(room.sessions[0]?.peers()).toEqual([]);
    expect(room.sessions[1]?.peers()).toEqual([]);
    // and every refusal is about a peer, never about a medium — the door has no `transport` rung
    const ids = new Set(peers.map((peer) => peer.identity.peerId));
    for (const ask of room.asked) expect(ids.has(ask.peer)).toBe(true);

    await room.stop();
  });

  test("a door that says nothing leaves every link standing, as a mesh without one does", async () => {
    const peers = suitePeers().slice(0, 2);
    const air = virtualFabric();
    const sessions = [createPeerSessions(), createPeerSessions()];
    const built = peers.map((_peer, i) =>
      wifiAware({
        id: ROOM,
        fabric: air.fabricFor(`d${String(i)}`, "wifi-aware"),
        name: `wifi:${String(i)}`,
      }),
    );
    await Promise.all(built.map((t, i) => t.start({ ...peers[i]!, sessions: sessions[i]! })));
    for (let round = 0; round < 8; round += 1) {
      await air.settle();
      for (const t of built) await t.flush?.();
    }

    expect(sessions[0]?.peers()).toEqual([peers[1]!.identity.peerId]);
    await Promise.all(built.map((t) => t.stop()));
  });
});

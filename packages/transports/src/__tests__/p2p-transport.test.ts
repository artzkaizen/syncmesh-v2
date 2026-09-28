import type {
  Connect,
  Severable,
  SuiteNetwork,
  SuitePeer,
} from "@syncmesh/transport/transport-tests";

import {
  severable,
  severableStream,
  suitePeers,
  transportTests,
} from "@syncmesh/transport/transport-tests";
import { describe, expect, test } from "bun:test";

import type { P2pFabric, P2pProtocol } from "../p2p/fabric.js";

import { awdl, wifiAware } from "../p2p/transport.js";
import { virtualFabric } from "../p2p/virtual-fabric.js";

const ROOM = "the-ward";
const build = { awdl, wifiAware };

/**
 * How often a chain prods a quiet path, small enough that a case can wait a deadline out.
 *
 * The contract gives a severed medium twenty settle rounds to notice by itself, and this is what
 * decides what those rounds are worth in milliseconds. A keepalive of 150ms drops a silent path
 * at 375ms: the same code path production runs at 5s, in a thirtieth of the time, comfortably
 * longer than the four rounds a `wake()` is allowed and comfortably longer again than the quiet
 * a case with a dropped frame in it goes through before it looks.
 */
const KEEPALIVE_MS = 150;

/**
 * The radio itself, between a real adapter and the virtual fabric — the part a switch in Settings
 * turns off.
 *
 * Off, it finds nobody, is found by nobody, opens no path, and carries nothing over the paths it
 * already had. What it does not do is say any of that: no peer-lost, no path close, no error. A
 * fixture that reported a lost peer here would be handing the adapter the one thing it never gets
 * from a radio that was switched off under it, and the case below would prove nothing.
 */
const radioOf = (fabric: P2pFabric, medium: Severable): P2pFabric => ({
  protocol: fabric.protocol,
  publish: async (service, announced) => {
    if (medium.carrying()) await fabric.publish(service, announced);
  },
  onPeerFound: (cb) =>
    fabric.onPeerFound((peer) => {
      if (medium.carrying()) cb(peer);
    }),
  onPeerLost: (cb) =>
    fabric.onPeerLost((id) => {
      if (medium.carrying()) cb(id);
    }),
  connect: async (id) => {
    if (!medium.carrying()) throw new Error(`${id} is not in range: this radio is off`);
    return severableStream(await fabric.connect(id), medium);
  },
  onPath: (cb) =>
    fabric.onPath((stream, from) => {
      if (medium.carrying()) cb(severableStream(stream, medium), from);
    }),
  stop: fabric.stop,
});

/**
 * Three real adapters on one virtual fabric, in a chain: each device is reported only its
 * neighbours, so the outer two can reach each other only through the middle. That is the
 * topology that catches a hop which quietly stops forwarding.
 */
const openChain = async (
  peers: readonly SuitePeer[],
  which: keyof typeof build,
  protocol: P2pProtocol,
) => {
  const air = virtualFabric();
  const medium = severable();
  const names = peers.map((_peer, i) => `device-${i}`);
  const transports = peers.map((_peer, i) => {
    const neighbours = [names[i - 1], names[i + 1]].filter((n): n is string => n !== undefined);
    return build[which]({
      id: ROOM,
      fabric: radioOf(air.fabricFor(names[i] ?? String(i), protocol, neighbours), medium),
      name: `${which}:${i}`,
      keepaliveMs: KEEPALIVE_MS,
    });
  });
  await Promise.all(transports.map((transport, i) => transport.start(peers[i]!)));

  const network = {
    transports,
    settle: async () => {
      // more rounds than a pair needs: a path opens with a handshake, the bridge attaches only
      // once that names the peer, and a chain has to carry the result one hop further
      for (let round = 0; round < 12; round += 1) {
        // real time, not only microtasks: what notices an abandoned path is a deadline, and a
        // settle that only drained promises would starve every timer in the transport under test
        await new Promise((resolve) => setTimeout(resolve, 4));
        await air.settle();
        for (const transport of transports) await transport.flush?.();
      }
    },
    stop: async () => {
      await Promise.all(transports.map((transport) => transport.stop()));
    },
    /** The OS said the radio moved: every device drops its paths and publishes again. */
    wake: () => transports.forEach((transport) => transport.wake?.()),
    chaos: {
      drop: (count: number) => air.drop(count),
      resyncAll: () => transports.forEach((transport) => transport.resync?.()),
      /** Every radio in the room goes off where it stands, and none of them mentions it. */
      sever: medium.sever,
      /** They are on again. A path opened before this one stays as dead as the radio left it. */
      restore: medium.restore,
    },
  } satisfies SuiteNetwork;
  return { air, medium, names, transports, network };
};

for (const [which, protocol] of [
  ["awdl", "awdl"],
  ["wifiAware", "wifi-aware"],
] as const) {
  const connect: Connect = async (peers) => (await openChain(peers, which, protocol)).network;

  describe(`${which} runs the transport contract`, () => {
    for (const suiteCase of transportTests(connect)) test(suiteCase.name, suiteCase.run);
  });

  describe(`${which} — what the source says about itself`, () => {
    test("its own kind, so a mixed fleet reads which radio failed", async () => {
      const { transports, network } = await openChain(suitePeers(), which, protocol);
      expect(transports[0]?.kind).toBe(protocol);
      // direct, wide, and costly: these radios hold a duty cycle and spend power doing it
      expect(transports[0]?.route?.()).toEqual({
        direct: true,
        bandwidthBps: 8_000_000,
        costly: true,
      });
      expect(transports[0]?.maxLinks?.()).toBe(4);
      await network.stop();
    });

    test("a peer that walks out of range takes its path with it, rather than hanging", async () => {
      const peers = suitePeers();
      const [a, , c] = peers;
      const { air, names, transports, network } = await openChain(peers, which, protocol);
      await network.settle();
      expect(transports[1]?.reaches?.().size).toBe(2);

      air.leaves(names[0] ?? "");
      await network.settle();
      // the middle keeps the neighbour it still has, and stops claiming the one it does not
      expect(transports[1]?.reaches?.()).toEqual(new Set([c.identity.peerId]));
      expect(transports[1]?.reaches?.().has(a.identity.peerId)).toBe(false);

      await network.stop();
    });
  });
}

describe("two protocols, two adapters, and no pretending otherwise", () => {
  test("an AWDL device and a Wi-Fi Aware device in one room never see each other", async () => {
    const peers = suitePeers();
    const air = virtualFabric();
    const apple = awdl({ id: ROOM, fabric: air.fabricFor("apple", "awdl") });
    const android = wifiAware({ id: ROOM, fabric: air.fabricFor("android", "wifi-aware") });
    await Promise.all([apple.start(peers[0]), android.start(peers[1])]);

    for (let round = 0; round < 6; round += 1) {
      await air.settle();
      await apple.flush?.();
      await android.flush?.();
    }

    // the same room, the same app, the same id — and no link, because the radios do not speak.
    // A merged `p2pWifi` would report this as one source that found nobody
    expect(apple.reaches?.().size).toBe(0);
    expect(android.reaches?.().size).toBe(0);

    await apple.stop();
    await android.stop();
  });

  test("two of the same protocol link, so the previous test is about the radio", async () => {
    const peers = suitePeers();
    const air = virtualFabric();
    const one = wifiAware({ id: ROOM, fabric: air.fabricFor("one", "wifi-aware") });
    const two = wifiAware({ id: ROOM, fabric: air.fabricFor("two", "wifi-aware") });
    await Promise.all([one.start(peers[0]), two.start(peers[1])]);

    for (let round = 0; round < 6; round += 1) {
      await air.settle();
      await one.flush?.();
      await two.flush?.();
    }

    expect(one.reaches?.()).toEqual(new Set([peers[1].identity.peerId]));
    await one.stop();
    await two.stop();
  });

  test("the wrong fabric fails where it is wired, not as a quiet room later", () => {
    const air = virtualFabric();
    expect(() => awdl({ id: ROOM, fabric: air.fabricFor("x", "wifi-aware") })).toThrow(
      "do not interoperate",
    );
    expect(() => wifiAware({ id: ROOM, fabric: air.fabricFor("y", "awdl") })).toThrow(
      "do not interoperate",
    );
  });
});

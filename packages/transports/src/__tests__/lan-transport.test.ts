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

import type { LanNetwork } from "../lan/network.js";

import { lan } from "../lan/transport.js";
import { virtualLan } from "../lan/virtual-lan.js";

const ROOM = "the-clinic";

/**
 * How often a chain announces and prods, small enough that a case can wait a deadline out.
 *
 * The contract gives a severed medium twenty settle rounds to notice by itself, and this is what
 * decides what those rounds are worth in milliseconds. A keepalive of 150ms hangs up on a silent
 * connection at 375ms: the same code path production runs at 5s, in a thirtieth of the time,
 * comfortably longer than the four rounds a `wake()` is allowed and comfortably longer again
 * than the quiet a case with a dropped frame in it goes through before it looks.
 */
const BEAT = { announceEveryMs: 10, keepaliveMs: 150 };

/**
 * The device's own network interface, between a real `lan()` and the virtual one — the layer a
 * Wi-Fi switch actually takes away.
 *
 * Everything below it keeps working: the access point is fine, the other devices are fine, and
 * this device's kernel accepts what it is handed. It simply carries none of it, and tells nobody
 * that it stopped — which is why the transport above goes on believing it holds the links it had.
 * Closing the connections here instead would be a fixture testing the one case that never
 * happened to a user.
 */
const interfaceOf = (network: LanNetwork, medium: Severable): LanNetwork => ({
  announce: (bytes) => {
    if (medium.carrying()) network.announce(bytes);
  },
  onAnnouncement: (cb) =>
    network.onAnnouncement((bytes, from) => {
      if (medium.carrying()) cb(bytes, from);
    }),
  address: network.address,
  dial: async (to) => {
    if (!medium.carrying()) throw new Error("no route to host: this device has no network");
    return severableStream(await network.dial(to), medium);
  },
  onConnection: (cb) =>
    network.onConnection((stream) => {
      if (medium.carrying()) cb(severableStream(stream, medium));
    }),
  close: network.close,
});

/**
 * Three real `lan()` transports on one virtual network, in a chain: each device hears only its
 * neighbours, so the outer two can reach each other only through the middle. That is the
 * topology that catches a hop which quietly stops forwarding — the failure a pair can never show.
 */
const openChain = async (peers: readonly SuitePeer[], room = ROOM) => {
  const air = virtualLan();
  const medium = severable();
  const names = peers.map((_peer, i) => `device-${i}`);
  const transports = peers.map((_peer, i) => {
    const neighbours = [names[i - 1], names[i + 1]].filter((n): n is string => n !== undefined);
    return lan({
      id: room,
      network: interfaceOf(air.networkFor(names[i] ?? String(i), neighbours), medium),
      name: `lan:${i}`,
      ...BEAT,
    });
  });
  await Promise.all(transports.map((transport, i) => transport.start(peers[i]!)));

  const network = {
    transports,
    settle: async () => {
      // a session opens with a handshake before the bridge has said anything at all, and an
      // announcement has to cross before there is a session to open
      for (let round = 0; round < 8; round += 1) {
        // real time, not only microtasks: what notices an abandoned socket is a deadline, and a
        // settle that only drained promises would starve every timer in the transport under test
        await new Promise((resolve) => setTimeout(resolve, 5));
        await air.settle();
        for (const transport of transports) await transport.flush?.();
      }
    },
    stop: async () => {
      await Promise.all(transports.map((transport) => transport.stop()));
    },
    /** The OS said the network moved: every device drops what it holds and announces again. */
    wake: () => transports.forEach((transport) => transport.wake?.()),
    chaos: {
      drop: (count: number) => air.drop(count),
      resyncAll: () => transports.forEach((transport) => transport.resync?.()),
      /** The access point is gone: no announcement, no dial, and nothing said about either. */
      sever: medium.sever,
      /** It is back, and only a connection opened after this carries anything. */
      restore: medium.restore,
    },
  } satisfies SuiteNetwork;
  return { air, medium, transports, network };
};

const connectOverLan: Connect = async (peers) => (await openChain(peers)).network;

describe("LAN runs the transport contract", () => {
  for (const suiteCase of transportTests(connectOverLan)) test(suiteCase.name, suiteCase.run);
});

describe("a local network says which peers it reaches (E28)", () => {
  test("a peer appears once its handshake proves it, and only its own neighbours do", async () => {
    const peers = suitePeers();
    const [a, b, c] = peers;
    const { transports, network } = await openChain(peers);
    await network.settle();
    const reached = (i: number) => transports[i]?.reaches?.();

    expect(reached(1)).toEqual(new Set([a.identity.peerId, c.identity.peerId]));
    expect(reached(0)).toEqual(new Set([b.identity.peerId]));
    // proven, not announced: an end never claims the peer it only hears of through the middle
    expect(reached(0)?.has(c.identity.peerId)).toBe(false);

    await network.stop();
  });

  test("closing the network takes its peers with it", async () => {
    const { transports, network } = await openChain(suitePeers());
    await network.settle();
    expect(transports[1]?.reaches?.().size).toBe(2);

    await network.stop();
    expect(transports[1]?.reaches?.().size).toBe(0);
  });

  test("dropping one peer leaves the other link standing", async () => {
    const peers = suitePeers();
    const [a, , c] = peers;
    const { transports, network } = await openChain(peers);
    await network.settle();

    transports[1]?.drop?.(a.identity.peerId);
    expect(transports[1]?.reaches?.()).toEqual(new Set([c.identity.peerId]));

    await network.stop();
  });
});

describe("one access point is not one mesh", () => {
  test("two rooms on the same network never link, however loudly each announces", async () => {
    const peers = suitePeers();
    const air = virtualLan();
    const clinic = lan({ id: "clinic", network: air.networkFor("a"), name: "lan:a" });
    const cafe = lan({ id: "cafe", network: air.networkFor("b"), name: "lan:b" });
    await Promise.all([clinic.start(peers[0]), cafe.start(peers[1])]);

    for (let round = 0; round < 6; round += 1) {
      await air.settle();
      await clinic.flush?.();
      await cafe.flush?.();
    }

    // the announcements crossed; the rooms did not. A dial here would open a link the bridge
    // then refuses for the whole of its life
    expect(clinic.reaches?.().size).toBe(0);
    expect(cafe.reaches?.().size).toBe(0);

    await clinic.stop();
    await cafe.stop();
  });

  test("the same room links, so the previous test is about the room and not the wiring", async () => {
    const peers = suitePeers();
    const air = virtualLan();
    const a = lan({ id: "clinic", network: air.networkFor("a"), name: "lan:a" });
    const b = lan({ id: "clinic", network: air.networkFor("b"), name: "lan:b" });
    await Promise.all([a.start(peers[0]), b.start(peers[1])]);

    for (let round = 0; round < 6; round += 1) {
      await air.settle();
      await a.flush?.();
      await b.flush?.();
    }

    expect(a.reaches?.()).toEqual(new Set([peers[1].identity.peerId]));
    expect(b.reaches?.()).toEqual(new Set([peers[0].identity.peerId]));

    await a.stop();
    await b.stop();
  });
});

describe("a device that arrives late", () => {
  test("is found by the repeat, which is the whole reason announcements repeat", async () => {
    const peers = suitePeers();
    const air = virtualLan();
    const beat = { announceEveryMs: 5 };
    const early = lan({ id: ROOM, network: air.networkFor("a"), name: "lan:a", ...beat });
    await early.start(peers[0]);
    await air.settle(); // the room hears an announcement nobody is there for yet

    const late = lan({ id: ROOM, network: air.networkFor("b"), name: "lan:b", ...beat });
    await late.start(peers[1]);

    // no second start to synchronise on: the link exists only because both kept saying so
    const linked = () => early.reaches?.().size === 1 && late.reaches?.().size === 1;
    for (let round = 0; round < 20 && !linked(); round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await air.settle();
      await early.flush?.();
      await late.flush?.();
    }

    expect(early.reaches?.()).toEqual(new Set([peers[1].identity.peerId]));
    expect(late.reaches?.()).toEqual(new Set([peers[0].identity.peerId]));

    await early.stop();
    await late.stop();
  });
});

describe("what the source says about itself (book ch. 16, 18)", () => {
  test("wide and direct, so a snapshot goes here rather than over a radio", () => {
    const source = lan({ id: ROOM, network: virtualLan().networkFor("a") });
    expect(source.kind).toBe("lan");
    expect(source.route?.()).toEqual({ direct: true, bandwidthBps: 20_000_000 });
    // no maxLinks: an access point is not a controller, and a number invented here would be a
    // budget the medium never asked for
    expect(source.maxLinks).toBeUndefined();
  });

  test("a network that will not carry announcements says so, in words a person can act on", async () => {
    const air = virtualLan();
    const network = air.networkFor("a");
    const broken = {
      ...network,
      announce: () => {
        throw new Error("no interface is up");
      },
    };
    const dropped: string[] = [];
    const source = lan({
      id: ROOM,
      network: broken,
      onDropped: (why) => void dropped.push(why),
    });
    await source.start(suitePeers()[0]);

    expect(source.condition?.()).toBe("discovery-failed");
    expect(dropped[0]).toContain("no interface is up");

    await source.stop();
  });
});

import type { Connect, SuiteNetwork, SuitePeer } from "@syncmesh/transport/transport-tests";

import { suitePeers, transportTests } from "@syncmesh/transport/transport-tests";
import { describe, expect, test } from "bun:test";

import { lan } from "../lan/transport.js";
import { virtualLan } from "../lan/virtual-lan.js";

const ROOM = "the-clinic";

/**
 * Three real `lan()` transports on one virtual network, in a chain: each device hears only its
 * neighbours, so the outer two can reach each other only through the middle. That is the
 * topology that catches a hop which quietly stops forwarding — the failure a pair can never show.
 */
const openChain = async (peers: readonly SuitePeer[], room = ROOM) => {
  const air = virtualLan();
  const names = peers.map((_peer, i) => `device-${i}`);
  const transports = peers.map((_peer, i) => {
    const neighbours = [names[i - 1], names[i + 1]].filter((n): n is string => n !== undefined);
    return lan({
      id: room,
      network: air.networkFor(names[i] ?? String(i), neighbours),
      name: `lan:${i}`,
    });
  });
  await Promise.all(transports.map((transport, i) => transport.start(peers[i]!)));

  const network = {
    settle: async () => {
      // a session opens with a handshake before the bridge has said anything at all, and an
      // announcement has to cross before there is a session to open
      for (let round = 0; round < 6; round += 1) {
        await air.settle();
        for (const transport of transports) await transport.flush?.();
      }
    },
    stop: async () => {
      await Promise.all(transports.map((transport) => transport.stop()));
    },
    chaos: {
      drop: (count: number) => air.drop(count),
      resyncAll: () => transports.forEach((transport) => transport.resync?.()),
    },
  } satisfies SuiteNetwork;
  return { air, transports, network };
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

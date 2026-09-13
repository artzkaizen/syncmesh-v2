import type { PeerId } from "@syncmesh/kernel";
import type { Transport } from "@syncmesh/transport";

import { parsePeerId } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { createPeers } from "../peers.js";

const id = (hex: string): PeerId => parsePeerId(hex.repeat(64).slice(0, 64)).unwrap();
const SELF = id("1");
const NEAR = id("2");
const FAR = id("3");

/** A medium that can name its links, and one that cannot — the two honest shapes of the port. */
const naming = (name: string, reaches: readonly PeerId[]): Transport => ({
  name,
  start: () => Promise.resolve(),
  whenReady: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  reaches: () => new Set(reaches),
});
const mute = (name: string): Transport => ({
  name,
  start: () => Promise.resolve(),
  whenReady: () => Promise.resolve(),
  stop: () => Promise.resolve(),
});

describe("the peer graph — who this device can reach, over what (book ch. 17)", () => {
  test("a peer on two mediums is one edge naming both, in attach order", () => {
    const peers = createPeers({
      self: SELF,
      transports: () => [naming("ble", [NEAR]), naming("relay", [NEAR, FAR])],
    });
    const graph = peers.graph();
    expect(graph.self).toBe(SELF);
    expect(graph.edges).toEqual([
      { peer: NEAR, over: ["ble", "relay"] },
      { peer: FAR, over: ["relay"] },
    ]);
    expect(peers.reaching(NEAR)).toEqual(["ble", "relay"]);
  });

  test("a medium that cannot enumerate its links is silent, not empty", () => {
    const peers = createPeers({
      self: SELF,
      transports: () => [mute("relay"), naming("ble", [NEAR])],
    });
    const graph = peers.graph();
    // saying "reaches nobody" for a socket multiplexing a room would be a claim, not a reading
    expect(graph.silent).toEqual(["relay"]);
    expect(graph.edges).toEqual([{ peer: NEAR, over: ["ble"] }]);
  });

  test("the snapshot is whole each time, so a consumer diffs rather than applies", () => {
    let reachable: readonly PeerId[] = [NEAR];
    const peers = createPeers({ self: SELF, transports: () => [naming("ble", reachable)] });
    expect(peers.graph().edges.map((e) => e.peer)).toEqual([NEAR]);
    reachable = [NEAR, FAR];
    expect(peers.graph().edges.map((e) => e.peer)).toEqual([NEAR, FAR]);
    reachable = [];
    expect(peers.graph().edges).toEqual([]);
    expect(peers.reaching(NEAR)).toEqual([]);
  });
});

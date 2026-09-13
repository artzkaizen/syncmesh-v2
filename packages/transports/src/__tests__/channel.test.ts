import type { OpenChannel } from "@syncmesh/transport/transport-tests";

import { channelTests } from "@syncmesh/transport/transport-tests";
import { describe, test } from "bun:test";

import { virtualLan } from "../lan/virtual-lan.js";
import { virtualFabric } from "../p2p/virtual-fabric.js";

/**
 * Every stand-in medium, against the channel contract.
 *
 * These are the mediums the whole adapter stack is proven on, so a place where one of them is
 * more forgiving than a socket is a place where a real device fails and no test does. Both
 * defects found while building them — the second connection to a peer whose first dial had not
 * landed, and buffered bytes handed over after later ones — live below this line.
 */

const overLan: OpenChannel = async () => {
  const room = virtualLan();
  const [a, b] = [room.networkFor("a"), room.networkFor("b")];
  let accepted: Parameters<Parameters<typeof b.onConnection>[0]>[0] | undefined;
  b.onConnection((stream) => void (accepted = stream));
  const near = await a.dial(b.address());
  await room.settle();
  if (accepted === undefined) throw new Error("the far end never accepted");
  return {
    a: near,
    b: accepted,
    settle: () => room.settle(),
    close: () => near.close(),
  };
};

const overFabric: OpenChannel = async () => {
  const air = virtualFabric();
  const [a, b] = [air.fabricFor("a", "wifi-aware"), air.fabricFor("b", "wifi-aware")];
  let accepted: Parameters<Parameters<typeof b.onPath>[0]>[0] | undefined;
  b.onPath((stream) => void (accepted = stream));
  await a.publish("svc", new Uint8Array(0));
  await b.publish("svc", new Uint8Array(0));
  await air.settle();
  const near = await a.connect("b");
  await air.settle();
  if (accepted === undefined) throw new Error("the far end never accepted");
  return {
    a: near,
    b: accepted,
    settle: () => air.settle(),
    close: () => near.close(),
  };
};

for (const [medium, open] of [
  ["the virtual LAN", overLan],
  ["the virtual Wi-Fi fabric", overFabric],
] as const) {
  describe(`${medium} satisfies the channel contract`, () => {
    for (const suiteCase of channelTests(open)) test(suiteCase.name, suiteCase.run);
  });
}

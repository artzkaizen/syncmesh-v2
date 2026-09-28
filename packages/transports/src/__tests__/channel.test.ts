import type { OpenChannel } from "@syncmesh/transport/transport-tests";

import { channelTests } from "@syncmesh/transport/transport-tests";
import { describe, test } from "bun:test";

import type { Path } from "../native-stream.js";

import { virtualLan } from "../lan/virtual-lan.js";
import { pathOver } from "../native-stream.js";
import { virtualFabric } from "../p2p/virtual-fabric.js";

/**
 * Every stand-in medium, against the channel contract.
 *
 * These are the mediums the whole adapter stack is proven on, so a place where one of them is
 * more forgiving than a socket is a place where a real device fails and no test does. Both
 * defects found while building them — the second connection to a peer whose first dial had not
 * landed, and buffered bytes handed over after later ones — live below this line.
 */

/**
 * The bridged path, against the same contract as the stand-ins.
 *
 * `pathOver` is the one channel in this package that ships to a device, and it was the one not
 * held to this suite — which is how it came to deliver bytes after its far end had gone, and to
 * swallow a close that landed before anyone listened for it. A module is modelled rather than
 * mocked: a send is accepted now and delivered later, exactly as a socket does, and a close
 * reaches the other end on its own turn, the way a FIN does rather than the way a shared flag
 * would.
 */
const overBridgedPath: OpenChannel = async () => {
  let flight: Promise<unknown> = Promise.resolve();
  const later = (run: () => void): void => void (flight = flight.then(run));
  /** Both halves of one bridged path, filled in below — each end's `send` names the other. */
  const ends: Partial<Record<"a" | "b", Path>> = {};
  const end = (far: "a" | "b"): Path =>
    pathOver(far === "b" ? "a" : "b", {
      // the platform tells the far end in its own time; nothing here is shared between the two
      close: () => later(() => ends[far]?.shut()),
      resume: () => undefined,
      send: (bytes) => {
        later(() => ends[far]?.accept(bytes));
        return Promise.resolve();
      },
    });
  ends.a = end("b");
  ends.b = end("a");
  const { a, b } = ends;
  if (a === undefined || b === undefined) throw new Error("both ends are built above");
  return {
    a: a.stream,
    b: b.stream,
    /**
     * Quiet, not "one flush".
     *
     * `pathOver` serialises its writes through a promise chain of its own, so a send only reaches
     * the far end a microtask after the one before it — awaiting the delivery queue once drains
     * whatever had already been handed to it and none of what is still queued behind. Rounds of
     * macrotask plus delivery queue are what actually reach a standstill.
     */
    settle: async () => {
      for (let round = 0; round < 8; round += 1) {
        await new Promise((done) => setTimeout(done, 0));
        await flight;
      }
    },
    close: () => a.stream.close(),
  };
};

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
  ["a bridged native path", overBridgedPath],
] as const) {
  describe(`${medium} satisfies the channel contract`, () => {
    for (const suiteCase of channelTests(open)) test(suiteCase.name, suiteCase.run);
  });
}

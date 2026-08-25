import { describe, test } from "bun:test";

import type { Connect } from "../transport-tests/index.js";

import { loopbackPair } from "../link.js";
import { transportTests } from "../transport-tests/index.js";
import { linkTransport } from "../transport.js";

/** A chain of loopback pairs: peer i holds one transport per adjacent link. */
const connectOverLoopback: Connect = async (peers) => {
  const pairs = peers.slice(1).map(() => loopbackPair());
  const transports = peers.map((_, i) => {
    const links = [...(i > 0 ? [pairs[i - 1]!.b] : []), ...(i < pairs.length ? [pairs[i]!.a] : [])];
    return links.map((link, n) => linkTransport(`loopback:${i}:${n}`, () => link));
  });
  await Promise.all(peers.flatMap((peer, i) => transports[i]!.map((t) => t.start(peer))));

  return {
    settle: async () => {
      for (let round = 0; round < 8; round += 1) {
        for (const pair of pairs) await pair.control.flush();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    stop: async () => {
      await Promise.all(transports.flat().map((t) => t.stop()));
    },
    chaos: {
      drop: (count) => pairs[0]!.control.dropNext(count),
      resyncAll: () => {
        for (const t of transports.flat()) t.resync?.();
      },
    },
  };
};
describe("loopback passes the transport contract", () => {
  for (const c of transportTests(connectOverLoopback)) test(c.name, c.run);
});

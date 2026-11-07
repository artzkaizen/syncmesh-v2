import { seed } from "@syncmesh/kernel/test-fixtures";

import type { Peer } from "../test-fixtures/index.js";

import { bridgeFramedLink } from "../bridge.js";
import { loopbackPair } from "../link.js";
import { T0 } from "../test-fixtures/index.js";

export * from "../test-fixtures/index.js";

/** Two peers bridged over one loopback, and the rounds that settle whatever they owe each other. */
export const connect = (x: Peer, y: Peer) => {
  const { a, b, control } = loopbackPair();
  const bridgeFor = (p: Peer, link: Parameters<typeof bridgeFramedLink>[0]) =>
    bridgeFramedLink(link, {
      engine: p.engine,
      identity: p.identity,
      grants: p.grants,
      now: () => T0,
    });
  const bx = bridgeFor(x, a);
  const by = bridgeFor(y, b);
  // one round per hop a frame can cause: cursors → events → cursors-back → events. Anything
  // needing more rounds than that is a bridge bug, not a test-timing problem.
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await control.flush();
      await bx.flush();
      await by.flush();
    }
  };
  return { bx, by, control, settle };
};

export { seed };

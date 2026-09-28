import { describe, expect, test } from "bun:test";

import type { BridgeOptions } from "../bridge.js";

import { bridgeFramedLink } from "../bridge.js";
import { loopbackPair } from "../link.js";
import { createRouteTable } from "../routes.js";
import { T0, peer } from "./fixtures.js";

/**
 * A chain: A — B — C, where only C answers for the authority. Nothing here is a network; it is
 * a room, and the question is whether A ends up knowing that the way to the authority is
 * through B (book ch. 17: online means routable).
 */
describe("routes across hops, over real bridges", () => {
  test("a service two hops away is reachable, and the next hop is the neighbour", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const c = peer(120, "acct_c");
    const tables = {
      a: createRouteTable({ self: a.identity.peerId, now: () => T0 }),
      b: createRouteTable({ self: b.identity.peerId, now: () => T0 }),
      c: createRouteTable({ self: c.identity.peerId, now: () => T0 }),
    };
    tables.c.serve("authority"); // only C is the authority

    const side = (
      p: typeof a,
      link: Parameters<typeof bridgeFramedLink>[0],
      routes: NonNullable<BridgeOptions["routes"]>,
    ) =>
      bridgeFramedLink(link, {
        engine: p.engine,
        identity: p.identity,
        grants: p.grants,
        now: () => T0,
        routes,
      });

    const ab = loopbackPair();
    const bc = loopbackPair();
    const bridges = [
      side(a, ab.a, tables.a),
      side(b, ab.b, tables.b),
      side(b, bc.a, tables.b),
      side(c, bc.b, tables.c),
    ];

    for (let round = 0; round < 10; round += 1) {
      await ab.control.flush();
      await bc.control.flush();
      for (const bridge of bridges) await bridge.flush();
    }

    // B is one hop from the authority, and knows it directly
    expect(tables.b.to("authority")?.via).toBe(c.identity.peerId);
    expect(tables.b.to("authority")?.hops).toBe(1);

    // A is two hops away, and the next hop is B — not C, which it has never met
    const fromA = tables.a.to("authority");
    expect(fromA?.via).toBe(b.identity.peerId);
    expect(fromA?.hops).toBe(2);

    // the middle walks out of the room: A has no path at all, said plainly rather than hung
    bridges[0]?.close();
    bridges[1]?.close();
    expect(tables.a.to("authority")).toBeUndefined();

    for (const bridge of bridges) bridge.close();
  });
});

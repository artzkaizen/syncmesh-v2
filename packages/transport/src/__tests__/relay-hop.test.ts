import { bytesEqual, decodeAndVerify, encodeEventCore } from "@syncmesh/wire";
import { fromALaterBuild } from "@syncmesh/wire/wire-tests";
import { describe, expect, test } from "bun:test";

import type { BridgeError } from "../bridge.js";

import { bridgeFramedLink } from "../bridge.js";
import { eventFrame, grantFrame } from "../frame.js";
import { loopbackPair } from "../link.js";
import { T0, bodyOf, connect, mintFor, peer, write } from "./fixtures.js";

describe("an added field survives a relay hop (D13)", () => {
  test("A's newer event reaches C through B as A's own bytes, and verifies there", async () => {
    const alice = peer(40, "acct_a");
    const bob = peer(80, "acct_b", 500);
    const carol = peer(120, "acct_c", 900);
    const dave = peer(160, "acct_d", 1300);

    const written = (await write(alice, "n1", "hello-carol")).unwrap();
    const future = fromALaterBuild(written, alice.identity);

    // the loss this guards against, asserted rather than assumed: what B can read is not what A signed
    const asBobReadsIt = encodeEventCore(decodeAndVerify(future.wire).unwrap().event);
    expect(bytesEqual(asBobReadsIt, future.core)).toBe(false);

    const bc = connect(bob, carol);
    // and one hop further, so what C stored is load-bearing rather than merely inspected: D can
    // only verify what C hands it, and C can only hand on the bytes it kept
    const cd = connect(carol, dave);
    const refused: BridgeError[] = [];
    bc.by.onError((e) => void refused.push(e));
    cd.by.onError((e) => void refused.push(e));
    await bc.settle();
    await cd.settle();

    // A is out of range of C: its grant and its event reach B down a link of their own
    const { a: fromAlice, b: intoBob, control } = loopbackPair();
    const ab = bridgeFramedLink(intoBob, {
      engine: bob.engine,
      identity: bob.identity,
      grants: bob.grants,
      now: () => T0,
    });
    fromAlice.send(grantFrame(mintFor(alice.identity, "acct_a")));
    fromAlice.send(eventFrame(future.wire));
    await control.flush();
    await ab.flush();
    await bc.settle();
    await cd.settle();

    expect(bodyOf(bob, "n1")).toBe("hello-carol");
    expect(bodyOf(carol, "n1")).toBe("hello-carol"); // it verified at the far side, so it folded
    // D never met A and never met B: it verified A's signature over bytes C forwarded, which C
    // could only do because it kept them
    expect(bodyOf(dave, "n1")).toBe("hello-carol");
    expect(refused).toEqual([]);

    // and it is A's bytes that landed there, not B's reading of them. Asserted without an escape
    // hatch: `core === undefined || equal` would pass for the very loss this test exists to catch,
    // and C is the last hop, so nothing else here would notice.
    const held = (await carol.engine.eventsSince(new Map())).unwrap();
    const relayed = held.find((e) => e.event.peerId === alice.identity.peerId);
    expect(relayed?.core).toBeDefined();
    expect(relayed?.sig).toBeDefined();
    expect(bytesEqual(relayed?.core ?? new Uint8Array(), future.core)).toBe(true);
    expect(bytesEqual(relayed?.sig ?? new Uint8Array(), future.sig)).toBe(true);

    // four engines, three hops apart, holding the same events: the comparison that matters
    expect([...carol.engine.digest()]).toEqual([...bob.engine.digest()]);
    expect([...dave.engine.digest()]).toEqual([...bob.engine.digest()]);

    ab.close();
    bc.bx.close();
    bc.by.close();
    cd.bx.close();
    cd.by.close();
  });
});

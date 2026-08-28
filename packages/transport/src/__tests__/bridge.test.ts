import type { Quarantined } from "@syncmesh/engine";
import type { SeqNum } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";

import type { BridgeError } from "../bridge.js";
import type { Frame } from "../frame.js";
import type { FrameLink } from "../link.js";
import type { Peer } from "./fixtures.js";

import { bridgeFramedLink } from "../bridge.js";
import { cursorsFrame, decodeFrame } from "../frame.js";
import { loopbackPair } from "../link.js";
import { ISSUER, T0, bodyOf, mintFor, peer, write } from "./fixtures.js";

const connect = (x: Peer, y: Peer) => {
  const { a, b, control } = loopbackPair();
  const bx = bridgeFramedLink(a, {
    engine: x.engine,
    identity: x.identity,
    grants: x.grants,
    now: () => T0,
  });
  const by = bridgeFramedLink(b, {
    engine: y.engine,
    identity: y.identity,
    grants: y.grants,
    now: () => T0,
  });
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

describe("the bridge over a loopback", () => {
  test("an event a peer says it already holds above its cursor is not sent again", async () => {
    const author = peer(40, "acct_a");
    const events = [];
    for (const n of [1, 2, 3]) events.push((await write(author, `n${n}`, `b${n}`)).unwrap());

    // one link end, driven by hand: we play a peer standing at cursor 1 that already holds seq 3
    const sent: Frame[] = [];
    const link: FrameLink = {
      send: (bytes) => void sent.push(decodeFrame(bytes).unwrap()),
      onFrame: (cb) => {
        deliver = cb;
        return () => undefined;
      },
    };
    let deliver: ((frame: Uint8Array) => void) | undefined;
    const bridge = bridgeFramedLink(link, {
      engine: author.engine,
      identity: author.identity,
      grants: author.grants,
      now: () => T0,
    });

    const seqs = events.map((event) => event.seqNum);
    // SAFETY: the loop above wrote three events, so both indexes exist
    const [first, , third] = seqs as [SeqNum, SeqNum, SeqNum];
    const at = new Map([[author.identity.peerId, first]]);
    const held = new Map([[author.identity.peerId, [third]]]);
    deliver?.(cursorsFrame(peer(81, "acct_b").identity.peerId, at, held));
    await bridge.flush();

    const offered = sent.filter((f) => f.kind === "event").length;
    expect(offered).toBe(1); // seq 2 only: seq 3 is one they told us they hold
    bridge.close();
  });

  test("grants travel first: two granted strangers converge with zero quarantines", async () => {
    const alice = peer(40, "acct_a");
    const bob = peer(80, "acct_b", 500);
    (await write(alice, "n1", "from-alice")).unwrap();
    const quarantined: Quarantined[] = [];
    bob.engine.onQuarantine((q) => void quarantined.push(q));

    const { settle } = connect(alice, bob);
    await settle();
    expect(quarantined).toEqual([]);
    expect(bodyOf(bob, "n1")).toBe("from-alice");

    (await write(bob, "n2", "from-bob")).unwrap();
    await settle();
    expect(bodyOf(alice, "n2")).toBe("from-bob");
  });

  test("gap rule: a dropped middle frame is held out, never jumped; resync recovers it", async () => {
    const alice = peer(40, "acct_a");
    const bob = peer(80, "acct_b", 500);
    const { control, by, settle } = connect(alice, bob);
    await settle();

    (await write(alice, "n1", "one")).unwrap();
    await settle();
    control.dropNext(1); // n2's live frame leaves alice and dies in the air
    (await write(alice, "n2", "two")).unwrap();
    (await write(alice, "n3", "three")).unwrap();
    await settle();
    expect(bodyOf(bob, "n1")).toBe("one");
    expect(bodyOf(bob, "n2")).toBeUndefined(); // held out — a max cursor would have jumped it
    expect(bodyOf(bob, "n3")).toBeUndefined();
    expect((await bob.engine.cursors()).unwrap().get(alice.identity.peerId)).toBe(
      (await alice.engine.eventsSince(new Map())).unwrap()[0]?.event.seqNum,
    );

    by.resync();
    await settle();
    expect(bodyOf(bob, "n2")).toBe("two");
    expect(bodyOf(bob, "n3")).toBe("three");
  });

  test("three peers: A's events and grant reach C through B, with A's original signature", async () => {
    const alice = peer(40, "acct_a");
    const bob = peer(80, "acct_b", 500);
    const carol = peer(120, "acct_c", 900);
    (await write(alice, "n1", "hello-carol")).unwrap();

    const ab = connect(alice, bob);
    await ab.settle();
    expect(bodyOf(bob, "n1")).toBe("hello-carol");

    // B↔C only — A is out of range. B relays A's grant (registered during A↔B) and A's event.
    const bc = connect(bob, carol);
    await bc.settle();
    expect(bodyOf(carol, "n1")).toBe("hello-carol");
    expect(carol.grants.grantFor(alice.identity.peerId)).toBeDefined();
  });

  test("grant-request: an ungranted newcomer asks, the far side answers, writes light up", async () => {
    const member = peer(40, "acct_m");
    const newcomerId = peer(160, "acct_n"); // helper builds a registry; make an ungranted one
    const newcomer = {
      ...newcomerId,
      grants: (await import("@syncmesh/wire")).createGrantRegistry({
        issuer: ISSUER.peerId,
        now: () => T0,
      }),
    };

    const { a, b, control } = loopbackPair();
    const requests: { peerId: string; invite?: string }[] = [];
    bridgeFramedLink(a, {
      engine: member.engine,
      identity: member.identity,
      grants: member.grants,
      now: () => T0,
      onGrantRequest: (r) => {
        const seen = { peerId: String(r.peerId) };
        if (r.invite !== undefined) Object.assign(seen, { invite: r.invite });
        requests.push(seen);
        // "M forwards to the issuer and carries the answer back" — registering emits the grant frame
        member.grants.register(mintFor(newcomer.identity, "acct_n")).unwrap();
      },
    });
    const bn = bridgeFramedLink(b, {
      engine: newcomer.engine,
      identity: newcomer.identity,
      grants: newcomer.grants,
      now: () => T0,
    });

    bn.requestGrant("inv-42");
    // one round per hop the answer takes: the request leaves the outbox, the far side registers
    // the grant it was asked for, and the grant frame comes back
    for (let round = 0; round < 3; round += 1) await control.flush();
    expect(requests).toEqual([{ peerId: String(newcomer.identity.peerId), invite: "inv-42" }]);
    expect(newcomer.grants.grantFor(newcomer.identity.peerId)?.account).toBe("acct_n");
  });

  test("send on a dead link is a loud error value, not silence", async () => {
    const alice = peer(40, "acct_a");
    const bob = peer(80, "acct_b", 500);
    const { control, bx, by, settle } = connect(alice, bob);
    await settle();
    const errors: BridgeError[] = [];
    bx.onError((e) => void errors.push(e));
    control.setOnline(false);
    (await write(alice, "n1", "lost")).unwrap();
    expect(errors.map((e) => e._tag)).toEqual(["SendFailed"]);

    control.setOnline(true);
    by.resync(); // the receiver re-requests — it is the side missing data
    await settle();
    expect(bodyOf(bob, "n1")).toBe("lost");
  });
});

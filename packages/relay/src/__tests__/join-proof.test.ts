import type { SeqNum } from "@syncmesh/kernel";

import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { joinCore, joinFrame } from "../frames.js";
import { proveJoin } from "../proof.js";
import { challengeOf, fakeSocket, openRoom, peer, seed, signedJoin } from "./fixtures.js";

/** A room at this build's own default: v2 only, a proof on every join. */
const strictRoom = () => openRoom({ versions: [2] });

describe("a join proves its key (D33)", () => {
  test("the room speaks first: a 32-byte challenge, fresh per socket", async () => {
    const room = await strictRoom();
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    room.connect(s1.socket);
    room.connect(s2.socket);
    expect(s1.frames()[0]?.kind).toBe("challenge");
    expect(challengeOf(s1)).toHaveLength(32);
    expect(challengeOf(s1)).not.toEqual(challengeOf(s2));
    room.close();
  });

  test("a bare join is refused as unproven, the socket closed, and nobody seated", async () => {
    const room = await strictRoom();
    const a = peer(40, "acct_a");
    const s = fakeSocket();
    room.connect(s.socket).receive(joinFrame([2], a.identity.peerId, new Map()));
    expect(s.ofKind("error").map((f) => f.code)).toEqual(["unproven"]);
    expect(s.closedWith).toEqual(["unproven"]);
    expect(s.ofKind("hello")).toHaveLength(0);
    expect(room.clients()).toBe(0);
    room.close();
  });

  test("a join signed by another key is refused; one signed by the key it names is greeted", async () => {
    const room = await strictRoom();
    const a = peer(40, "acct_a");
    const other = createIdentity(seed(99)).unwrap();

    const forged = fakeSocket();
    const conn = room.connect(forged.socket);
    const core = joinCore([2], a.identity.peerId, new Map());
    conn.receive(
      joinFrame(
        [2],
        a.identity.peerId,
        new Map(),
        undefined,
        proveJoin(other, challengeOf(forged), core),
      ),
    );
    expect(forged.ofKind("error").map((f) => f.code)).toEqual(["unproven"]);
    expect(room.clients()).toBe(0);

    const honest = fakeSocket();
    room.connect(honest.socket).receive(signedJoin(a.identity, challengeOf(honest)));
    expect(honest.ofKind("error")).toHaveLength(0);
    expect(honest.ofKind("hello")).toHaveLength(1);
    expect(room.clients()).toBe(1);
    room.close();
  });

  test("a stranger cannot take a device's seat, nor hang up on it", async () => {
    const room = await strictRoom();
    const a = peer(40, "acct_a");
    const stranger = createIdentity(seed(99)).unwrap();

    const seat = fakeSocket();
    room.connect(seat.socket).receive(signedJoin(a.identity, challengeOf(seat)));
    expect(room.clients()).toBe(1);

    // the old hole: a bare join naming `a` used to close `a`'s socket as "superseded"
    const bare = fakeSocket();
    room.connect(bare.socket).receive(joinFrame([2], a.identity.peerId, new Map()));
    expect(bare.closedWith).toEqual(["unproven"]);
    expect(seat.closedWith).toEqual([]);
    expect(room.clients()).toBe(1);

    // nor with a real signature from the wrong key
    const signed = fakeSocket();
    const conn = room.connect(signed.socket);
    const core = joinCore([2], a.identity.peerId, new Map());
    conn.receive(
      joinFrame(
        [2],
        a.identity.peerId,
        new Map(),
        undefined,
        proveJoin(stranger, challengeOf(signed), core),
      ),
    );
    expect(signed.closedWith).toEqual(["unproven"]);
    expect(seat.closedWith).toEqual([]);
    expect(room.clients()).toBe(1);
    room.close();
  });

  test("a proof does not survive a change to the body it covers", async () => {
    const room = await strictRoom();
    const a = peer(40, "acct_a");
    const s = fakeSocket();
    const conn = room.connect(s.socket);
    // SAFETY: a sequence is a branded positive integer; this is a documented literal
    const claimed = new Map([[a.identity.peerId, 7 as SeqNum]]);
    // signed over empty cursors, sent with a claim to hold seven: a machine in the middle
    // re-cursoring a join it forwards would look exactly like this
    const proof = proveJoin(
      a.identity,
      challengeOf(s),
      joinCore([2], a.identity.peerId, new Map()),
    );
    conn.receive(joinFrame([2], a.identity.peerId, claimed, undefined, proof));
    expect(s.ofKind("error").map((f) => f.code)).toEqual(["unproven"]);
    expect(room.clients()).toBe(0);
    room.close();
  });

  test("a proof is for one socket: replayed on another, it opens nothing", async () => {
    const room = await strictRoom();
    const a = peer(40, "acct_a");
    const first = fakeSocket();
    room.connect(first.socket);
    const join = signedJoin(a.identity, challengeOf(first));

    const replay = fakeSocket();
    room.connect(replay.socket).receive(join);
    expect(replay.ofKind("error").map((f) => f.code)).toEqual(["unproven"]);
    expect(room.clients()).toBe(0);
    room.close();
  });

  test("a re-join on the same socket re-signs the same challenge over its new cursors", async () => {
    const room = await strictRoom();
    const a = peer(40, "acct_a");
    const s = fakeSocket();
    const conn = room.connect(s.socket);
    const nonce = challengeOf(s);
    conn.receive(signedJoin(a.identity, nonce));
    // SAFETY: a sequence is a branded positive integer; this is a documented literal
    conn.receive(signedJoin(a.identity, nonce, new Map([[a.identity.peerId, 3 as SeqNum]])));
    expect(s.ofKind("error")).toHaveLength(0);
    expect(s.ofKind("hello")).toHaveLength(2);
    expect(room.clients()).toBe(1);
    room.close();
  });

  test("a room its operator left open to v1 admits a bare v1 join, and still refuses a wrong proof", async () => {
    const room = await openRoom({ versions: [1, 2] });
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const stranger = createIdentity(seed(99)).unwrap();

    const trusted = fakeSocket();
    room.connect(trusted.socket).receive(joinFrame([1], a.identity.peerId, new Map()));
    expect(trusted.ofKind("hello")).toHaveLength(1);

    // a v2 join is held to v2's rule whatever else the room admits
    const bareV2 = fakeSocket();
    room.connect(bareV2.socket).receive(joinFrame([2], b.identity.peerId, new Map()));
    expect(bareV2.ofKind("error").map((f) => f.code)).toEqual(["unproven"]);

    // and a wrong signature is never the absence of one, even at v1
    const wrong = fakeSocket();
    const conn = room.connect(wrong.socket);
    const core = joinCore([1], b.identity.peerId, new Map());
    conn.receive(
      joinFrame(
        [1],
        b.identity.peerId,
        new Map(),
        undefined,
        proveJoin(stranger, challengeOf(wrong), core),
      ),
    );
    expect(wrong.ofKind("error").map((f) => f.code)).toEqual(["unproven"]);
    expect(room.clients()).toBe(1);
    room.close();
  });
});

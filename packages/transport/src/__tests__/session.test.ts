import type { PeerId } from "@syncmesh/kernel";
import type { FrameLink } from "@syncmesh/transport";
import type { Identity } from "@syncmesh/wire";

import { seed } from "@syncmesh/kernel/test-fixtures";
import { loopbackPair } from "@syncmesh/transport";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import {
  HELLO,
  SEALED,
  ephemeralSecret,
  readHello,
  seal,
  sealNonce,
  sessionKeys,
  unseal,
  writeHello,
} from "../handshake.js";
import { KEYS_REMEMBERED, secureLink } from "../session.js";

const ALICE = createIdentity(seed(11)).unwrap();
const BOB = createIdentity(seed(12)).unwrap();
const MALLORY = createIdentity(seed(13)).unwrap();

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** What one end saw: the frames handed up, the peer it proved, and anything it refused. */
const watch = (link: FrameLink, identity: Identity, options: { maxPending?: number } = {}) => {
  const got: string[] = [];
  const dropped: string[] = [];
  const failed: unknown[] = [];
  const superseded: PeerId[] = [];
  let peer: PeerId | undefined;
  const secure = secureLink(link, {
    identity,
    onDropped: (why) => void dropped.push(why),
    onFailed: (cause) => void failed.push(cause),
    onEstablished: (id) => void (peer = id),
    onSuperseded: (id) => void superseded.push(id),
    ...options,
  });
  secure.onFrame((frame) => void got.push(text(frame)));
  return { secure, got, dropped, failed, superseded, peer: () => peer };
};

/** Two devices over an in-process radio, plus everything either of them put on the air. */
const pair = () => {
  const wire = loopbackPair();
  const air = { toB: new Array<Uint8Array>(), toA: new Array<Uint8Array>() };
  wire.b.onFrame((f) => void air.toB.push(f));
  wire.a.onFrame((f) => void air.toA.push(f));
  return {
    air,
    a: watch(wire.a, ALICE),
    b: watch(wire.b, BOB),
    raw: wire,
    /**
     * Until the air goes quiet. One `flush` advances the loopback's chain by a link, and the
     * exchange is three deep — hello out, hello back, then whatever was held — so a single one
     * would settle the handshake and leave the frames it released still in flight.
     */
    settle: async () => {
      for (let before = -1; before !== air.toA.length + air.toB.length;) {
        before = air.toA.length + air.toB.length;
        await wire.control.flush();
      }
    },
  };
};

/** A link whose frames a test delivers by hand, for what the loopback's shared switch cannot show. */
const stub = () => {
  const listeners = new Set<(frame: Uint8Array) => void>();
  const sent: Uint8Array[] = [];
  let closed = false;
  const link: FrameLink = {
    send: (frame) => void sent.push(frame),
    onFrame: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    close: () => void (closed = true),
  };
  return {
    link,
    sent,
    closed: () => closed,
    deliver: (f: Uint8Array) => listeners.forEach((cb) => cb(f)),
  };
};

describe("two devices opening a session", () => {
  test("say hello without waiting for each other, then carry frames both ways", async () => {
    const link = pair();
    await link.settle();
    expect(link.a.peer()).toBe(BOB.peerId);
    expect(link.b.peer()).toBe(ALICE.peerId);

    link.a.secure.send(bytes("from alice"));
    link.b.secure.send(bytes("from bob"));
    await link.settle();
    expect(link.b.got).toEqual(["from alice"]);
    expect(link.a.got).toEqual(["from bob"]);
  });

  test("hold what the bridge sends before the key exists rather than dropping it", async () => {
    const link = pair();
    // the bridge sends its grants and cursors the instant it attaches, which is before this
    link.a.secure.send(bytes("grants"));
    link.a.secure.send(bytes("cursors"));
    await link.settle();
    expect(link.b.got).toEqual(["grants", "cursors"]);
  });

  test("a sniffer sees a hello and then only ciphertext", async () => {
    const link = pair();
    await link.settle();
    link.a.secure.send(bytes("the-account-number"));
    await link.settle();

    expect(link.air.toB[0]?.[0]).toBe(HELLO);
    expect(link.air.toB.slice(1).every((frame) => frame[0] === SEALED)).toBe(true);
    const heard = Buffer.concat(link.air.toB.map((f) => Buffer.from(f)));
    expect(heard.includes(Buffer.from("the-account-number"))).toBe(false);
  });
});

describe("a session refusing what it should", () => {
  test("plaintext injected onto an open session is dropped, never handed up", async () => {
    const link = pair();
    await link.settle();
    link.raw.a.send(bytes("trust me, I am a frame"));
    await link.settle();
    expect(link.b.got).toEqual([]);
    expect(link.b.dropped).toHaveLength(1);
  });

  test("a frame sealed under some other session does not open here", async () => {
    const link = pair();
    const other = pair();
    await Promise.all([link.settle(), other.settle()]);
    other.a.secure.send(bytes("someone else's traffic"));
    await other.settle();
    const [, sealed] = other.air.toB;
    if (sealed !== undefined) link.raw.a.send(sealed);
    await link.settle();
    expect(link.b.got).toEqual([]);
  });

  test("a hello nobody signed ends the link instead of opening one", () => {
    const radio = stub();
    const alice = watch(radio.link, ALICE);
    const forged = new Uint8Array(129);
    forged[0] = HELLO;
    radio.deliver(forged);
    expect(alice.failed).toHaveLength(1);
    expect(alice.peer()).toBeUndefined();
  });

  test("noise before the handshake is dropped, because a radio carries other people's traffic", () => {
    const radio = stub();
    const alice = watch(radio.link, ALICE);
    radio.deliver(bytes("someone else's protocol entirely"));
    expect(alice.failed).toEqual([]);
    expect(alice.dropped).toHaveLength(1);
  });

  test("a peer that never answers stops taking frames rather than growing without bound", async () => {
    const wire = loopbackPair();
    const alice = watch(wire.a, ALICE, { maxPending: 2 });
    alice.secure.send(bytes("one"));
    alice.secure.send(bytes("two"));
    expect(() => alice.secure.send(bytes("three"))).toThrow("never said hello");
  });

  test("closing stops the session and the link under it, and hands nothing up after", () => {
    const radio = stub();
    const alice = watch(radio.link, ALICE);
    const bobSecret = ephemeralSecret();
    const bob = writeHello(BOB, bobSecret);
    radio.deliver(bob.frame);
    expect(alice.peer()).toBe(BOB.peerId);

    alice.secure.close?.();
    expect(radio.closed()).toBe(true);
    const keys = sessionKeys(bobSecret, bob, readHello(radio.sent[0] ?? new Uint8Array()).unwrap());
    radio.deliver(seal(keys.unwrap().seal, bytes("after the close"), sealNonce()));
    expect(alice.got).toEqual([]);
  });
});

/**
 * One end of a session driven by hand: what a peer that restarted actually does to the peer that
 * did not. The other side is a `stub`, because the two halves have to be out of step — which a
 * loopback pair, being one switch, cannot be.
 */
const bobSays = (radio: ReturnType<typeof stub>) => {
  const secret = ephemeralSecret();
  const hello = writeHello(BOB, secret);
  radio.deliver(hello.frame);
  const answered = radio.sent.filter((frame) => frame[0] === HELLO).at(-1);
  const keys = sessionKeys(
    secret,
    hello,
    readHello(answered ?? new Uint8Array()).unwrap(),
  ).unwrap();
  return {
    hello,
    keys,
    /** What the far end would hand up, sealed under the session this hello agreed. */
    send: (what: string) => radio.deliver(seal(keys.seal, bytes(what), sealNonce())),
  };
};

describe("two live sessions that re-key each other converge (chaos: three BLE radios)", () => {
  /**
   * The loop this pins: an established session answered a fresh hello with a fresh hello of its
   * own, the far side — also established — answered *that* with another, and the pair re-keyed
   * each other at microtask speed with no timer in the path. Three BLE radios reach it on their
   * own, because two of them dial each other and the transport folds both connections into one
   * link. Driven through the stub so every frame is delivered by hand: a regression here is a
   * failed assertion, never a hung suite.
   */
  test("a fresh hello is answered once; the answer to that answer is taken, not re-offered", () => {
    const radio = stub();
    const alice = watch(radio.link, ALICE);
    const first = bobSays(radio);
    first.send("settled"); // Alice has unsealed under this session: her hello is confirmed
    expect(alice.got).toEqual(["settled"]);
    const hellosBefore = radio.sent.filter((f) => f[0] === HELLO).length;

    // Bob's other connection surfaces as a fresh hello on the same link: Alice must offer
    const second = bobSays(radio);
    expect(alice.superseded).toEqual([BOB.peerId]);
    expect(radio.sent.filter((f) => f[0] === HELLO).length).toBe(hellosBefore + 1);
    const offered = readHello(radio.sent.filter((f) => f[0] === HELLO).at(-1)!).unwrap();

    // Bob, live and established too, answers Alice's fresh hello with a fresh hello of his own —
    // exactly what a peer running this same code does. Alice's hello is unconfirmed, so this is
    // the answer to it: she agrees under what she already offered and sends nothing more
    const secret = ephemeralSecret();
    const answer = writeHello(BOB, secret);
    radio.deliver(answer.frame);
    expect(alice.superseded).toEqual([BOB.peerId, BOB.peerId]);
    expect(radio.sent.filter((f) => f[0] === HELLO).length).toBe(hellosBefore + 1); // no third hello

    // and the keys converged: what Bob derives from (his answer, Alice's offer) opens both ways
    const keys = sessionKeys(secret, answer, offered).unwrap();
    radio.deliver(seal(keys.seal, bytes("converged"), sealNonce()));
    expect(alice.got).toEqual(["settled", "converged"]);
    alice.secure.send(bytes("and back"));
    expect(text(unseal(keys.open, radio.sent.at(-1)!).unwrap())).toBe("and back");
    void second;
  });

  test("a restarted peer still gets a fresh offer: confirmation is what tells the two apart", () => {
    const radio = stub();
    const alice = watch(radio.link, ALICE);
    const before = bobSays(radio);
    before.send("first life");
    const hellos = () => radio.sent.filter((f) => f[0] === HELLO).length;
    const n = hellos();
    // Bob restarts: his new session has no keys and needs a hello it has never seen
    const after = bobSays(radio);
    expect(hellos()).toBe(n + 1);
    after.send("second life");
    expect(alice.got).toEqual(["first life", "second life"]);
  });
});

describe("a peer that starts over on a link nothing said had ended", () => {
  test("its second hello takes the session, and frames cross again", () => {
    const radio = stub();
    const alice = watch(radio.link, ALICE);
    const first = bobSays(radio);
    first.send("before the radio went");
    expect(alice.got).toEqual(["before the radio went"]);

    // Bluetooth off and on: Bob's device kept nothing, and Alice's stack was told nothing
    const second = bobSays(radio);
    expect(alice.superseded).toEqual([BOB.peerId]);
    second.send("after it came back");
    expect(alice.got).toEqual(["before the radio went", "after it came back"]);

    // and the other direction, which is the half that was stranded: Alice's frames open under
    // the new session rather than arriving as bytes Bob has no key for
    alice.secure.send(bytes("and back the other way"));
    const sealed = radio.sent.at(-1) ?? new Uint8Array();
    expect(text(unseal(second.keys.open, sealed).unwrap())).toBe("and back the other way");
  });

  test("a stranger's hello cannot take a link off the peer that proved it", () => {
    const radio = stub();
    const alice = watch(radio.link, ALICE);
    const bob = bobSays(radio);

    radio.deliver(writeHello(MALLORY, ephemeralSecret()).frame);
    expect(alice.superseded).toEqual([]);
    expect(alice.dropped.at(-1)).toContain(MALLORY.peerId.slice(0, 8));

    // Bob's session is untouched, which is the whole of what refusing was for
    bob.send("still bob's link");
    expect(alice.got).toEqual(["still bob's link"]);
  });

  test("the hello this session was agreed under, offered again, is a replay and is refused", () => {
    const radio = stub();
    const alice = watch(radio.link, ALICE);
    const bob = bobSays(radio);

    radio.deliver(bob.hello.frame);
    expect(alice.superseded).toEqual([]);
    expect(alice.dropped.at(-1)).toContain("already agreed a session under");

    bob.send("still readable");
    expect(alice.got).toEqual(["still readable"]);
  });

  test("the keys it remembers are a window, so a link does not grow for as long as it works", () => {
    const radio = stub();
    const alice = watch(radio.link, ALICE);
    const first = bobSays(radio);

    // every restart is one more key to remember, and superseding is what keeps this link object
    // alive across them — so an unbounded set grows for exactly as long as the feature works
    const sessions = [first];
    for (let restart = 0; restart < KEYS_REMEMBERED; restart += 1) sessions.push(bobSays(radio));
    expect(alice.superseded.length).toBe(KEYS_REMEMBERED);

    // the newest is still refused: the window is what the guard is actually for, and a replay is
    // answerable in the seconds after it is captured rather than a hundred sessions later
    const newest = sessions.at(-1) ?? first;
    radio.deliver(newest.hello.frame);
    expect(alice.dropped.at(-1)).toContain("already agreed a session under");

    // and the oldest has been let go rather than kept forever — replaying it is accepted, which
    // is the cost being paid for the bound and is the thing worth stating out loud
    radio.deliver(first.hello.frame);
    expect(alice.superseded.length).toBe(KEYS_REMEMBERED + 1);
  });
});

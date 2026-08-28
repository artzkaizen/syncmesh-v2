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
  writeHello,
} from "../handshake.js";
import { secureLink } from "../session.js";

const ALICE = createIdentity(seed(11)).unwrap();
const BOB = createIdentity(seed(12)).unwrap();

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** What one end saw: the frames handed up, the peer it proved, and anything it refused. */
const watch = (link: FrameLink, identity: Identity, options: { maxPending?: number } = {}) => {
  const got: string[] = [];
  const dropped: string[] = [];
  const failed: unknown[] = [];
  let peer: PeerId | undefined;
  const secure = secureLink(link, {
    identity,
    onDropped: (why) => void dropped.push(why),
    onFailed: (cause) => void failed.push(cause),
    onEstablished: (id) => void (peer = id),
    ...options,
  });
  secure.onFrame((frame) => void got.push(text(frame)));
  return { secure, got, dropped, failed, peer: () => peer };
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

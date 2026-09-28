import type { LinkEvent } from "@syncmesh/transport";

import { seed } from "@syncmesh/kernel/test-fixtures";
import { SEALED, readHello } from "@syncmesh/transport";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { RelayDial } from "../transport.js";

import { decodeRelayFrame, joinFrame } from "../frames.js";
import { isHello, secureLink } from "../secure.js";
import { relayTransport } from "../transport.js";
import {
  bodyOf,
  dialTo,
  fakeSocket,
  openRoom,
  peer,
  scriptedRoom,
  tick,
  write,
} from "./fixtures.js";

const ROOM_KEY = createIdentity(seed(7)).unwrap();

/** The frames a scripted socket was sent, decoded — the hello set aside, sealed ones opened by `link`. */
const said = (s: ReturnType<typeof fakeSocket>, link?: ReturnType<typeof secureLink>) =>
  s.sent
    .filter((bytes) => !isHello(bytes))
    .map((bytes) => {
      const plain =
        link === undefined || bytes[0] !== SEALED ? bytes : link.receive(bytes).unwrap();
      return decodeRelayFrame(plain ?? bytes).unwrap();
    });

/** A device's end of the link against a scripted socket: answers the room's hello, returns the link. */
const shake = (
  s: ReturnType<typeof fakeSocket>,
  conn: { receive: (b: Uint8Array) => void },
  n: number,
) => {
  const identity = createIdentity(seed(n)).unwrap();
  const link = secureLink(identity);
  const hello = s.sent[0];
  if (hello === undefined || !isHello(hello)) throw new Error("the room sent no hello");
  link.receive(hello).unwrap();
  if (link.hello === undefined) throw new Error("the device made no hello");
  conn.receive(link.hello);
  return { identity, link };
};

describe("the relay socket is a sealed link (D36)", () => {
  test("the room speaks first: a hello signed by its own key, a fresh ephemeral per socket", async () => {
    const room = await openRoom({ identity: ROOM_KEY });
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    room.connect(s1.socket);
    room.connect(s2.socket);
    const h1 = readHello(s1.sent[0] ?? new Uint8Array()).unwrap();
    const h2 = readHello(s2.sent[0] ?? new Uint8Array()).unwrap();
    expect(h1.peerId).toBe(ROOM_KEY.peerId);
    expect(h2.peerId).toBe(ROOM_KEY.peerId);
    expect(h1.ephemeral).not.toEqual(h2.ephemeral);
    expect(s1.sent).toHaveLength(1); // and nothing else until the device has answered
    room.close();
  });

  test("a join in the clear is refused as `handshake`, the socket closed, and nobody seated", async () => {
    const room = await openRoom();
    const a = peer(40, "acct_a");
    const s = fakeSocket();
    room.connect(s.socket).receive(joinFrame([3], a.identity.peerId, new Map()));
    expect(said(s).map((f) => (f.kind === "error" ? f.code : f.kind))).toEqual(["handshake"]);
    expect(s.closedWith).toEqual(["handshake"]);
    expect(room.clients()).toBe(0);
    room.close();
  });

  test("a device that answers the hello is seated under the key the hello proved, and everything after travels sealed", async () => {
    const room = await openRoom();
    const s = fakeSocket();
    const conn = room.connect(s.socket);
    const { identity, link } = shake(s, conn, 40);
    expect(s.sent).toHaveLength(1); // the handshake itself is silent on the room's side
    conn.receive(link.seal(joinFrame([3], identity.peerId, new Map())) ?? new Uint8Array());
    expect(room.clients()).toBe(1);
    // every byte after the hello is a sealed frame: nothing on this socket reads without the key
    for (const bytes of s.sent.slice(1)) expect(bytes[0]).toBe(SEALED);
    const hello = said(s, link).find((f) => f.kind === "hello");
    expect(hello?.kind === "hello" && hello.version).toBe(3);
    room.close();
  });

  test("a join naming another key than the one that opened the link is an `impostor`, seated nowhere", async () => {
    const room = await openRoom();
    const a = peer(40, "acct_a");
    const seat = fakeSocket();
    const seated = room.connect(seat.socket);
    const mine = shake(seat, seated, 40);
    seated.receive(
      mine.link.seal(joinFrame([3], a.identity.peerId, new Map())) ?? new Uint8Array(),
    );
    expect(room.clients()).toBe(1);

    const s = fakeSocket();
    const conn = room.connect(s.socket);
    const { link } = shake(s, conn, 80); // a different device on the link…
    conn.receive(link.seal(joinFrame([3], a.identity.peerId, new Map())) ?? new Uint8Array()); // …asking for a's seat
    expect(said(s, link).map((f) => (f.kind === "error" ? f.code : f.kind))).toEqual(["impostor"]);
    expect(s.closedWith).toEqual(["impostor"]);
    expect(seat.closedWith).toEqual([]); // the real device was not hung up on
    expect(room.clients()).toBe(1);
    room.close();
  });

  test("after the handshake a frame in the clear is a downgrade, and a frame that does not open is not ours", async () => {
    const room = await openRoom();
    const a = peer(40, "acct_a");
    const clear = fakeSocket();
    const c1 = room.connect(clear.socket);
    shake(clear, c1, 40);
    c1.receive(joinFrame([3], a.identity.peerId, new Map()));
    expect(clear.closedWith).toEqual(["handshake"]);

    const tampered = fakeSocket();
    const c2 = room.connect(tampered.socket);
    const { identity, link } = shake(tampered, c2, 40);
    const sealed = link.seal(joinFrame([3], identity.peerId, new Map())) ?? new Uint8Array();
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;
    c2.receive(sealed);
    expect(tampered.closedWith).toEqual(["handshake"]);
    expect(room.clients()).toBe(0);
    room.close();
  });

  test("a room that lists 3 beside an older version is a definition mistake", async () => {
    await expect(openRoom({ versions: [2, 3] })).rejects.toThrow(/lists 3 alone/);
    await expect(openRoom({ versions: [1, 3] })).rejects.toThrow(/lists 3 alone/);
  });

  test("two devices converge through the sealed room, and a sniffer on the socket sees no frame in the clear after the hellos", async () => {
    const room = await openRoom();
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    await write(a, "n1", "one");
    const sniffed: Uint8Array[] = [];
    const tap = (wired: ReturnType<typeof dialTo>) => async (): Promise<RelayDial> => {
      const dialed = await wired.dial();
      return {
        ...dialed,
        send: (frame) => {
          sniffed.push(frame);
          dialed.send(frame);
        },
        onFrame: (cb) =>
          dialed.onFrame((bytes) => {
            sniffed.push(bytes);
            cb(bytes);
          }),
      };
    };
    const ta = relayTransport({ dial: tap(dialTo(room)), reconnectMs: 10 });
    const tb = relayTransport({ dial: tap(dialTo(room)), reconnectMs: 10 });
    await ta.start(a.context);
    await tb.start(b.context);
    await ta.whenReady();
    await tb.whenReady();
    await tick(30);
    await write(b, "n2", "two");
    await tick(30);
    expect(bodyOf(b, "n1")).toBe("one");
    expect(bodyOf(a, "n2")).toBe("two");
    expect(room.clients()).toBe(2);
    expect(sniffed.filter(isHello)).toHaveLength(4); // two per socket, one each way
    for (const bytes of sniffed.filter((b) => !isHello(b))) {
      expect(bytes[0]).toBe(SEALED);
      expect(decodeRelayFrame(bytes).isOk()).toBe(false);
    }
    await ta.stop();
    await tb.stop();
    room.close();
  });

  test("a client offering only the sealed link is refused for good by a room that challenges instead", async () => {
    const room = await scriptedRoom();
    const a = peer(40, "acct_a");
    const wired = dialTo(room);
    const seen: LinkEvent[] = [];
    const t = relayTransport({ dial: wired.dial, reconnectMs: 5, forceReadyAfter: 20 });
    t.onLinkEvent?.((event) => void seen.push(event));
    await t.start(a.context);
    await t.whenReady();
    await tick(40);
    expect(seen.map((e) => e.kind)).toContain("refused");
    expect(wired.dials()).toBe(1); // permanent: no reconnect loop against a relay that cannot speak it
    expect(room.clients()).toBe(0);
    await t.stop();
    room.close();
  });

  test("a client told to offer 2 still answers a challenging room, and a room told to admit 2 still refuses a wrong proof", async () => {
    const room = await scriptedRoom();
    const a = peer(40, "acct_a");
    const t = relayTransport({ dial: dialTo(room).dial, versions: [2], reconnectMs: 5 });
    await t.start(a.context);
    await t.whenReady();
    await tick(20);
    expect(room.clients()).toBe(1);
    await t.stop();
    room.close();
  });

  test("a device pinned to the room's key converges; one pinned to another key is refused for good", async () => {
    const room = await openRoom({ identity: ROOM_KEY });
    const a = peer(40, "acct_a");
    const wired = dialTo(room);
    const pinned = relayTransport({ dial: wired.dial, relayKey: ROOM_KEY.peerId, reconnectMs: 5 });
    await pinned.start(a.context);
    await pinned.whenReady();
    await tick(20);
    expect(room.clients()).toBe(1);

    const b = peer(80, "acct_b");
    const other = dialTo(room);
    const seen: LinkEvent[] = [];
    const wrong = relayTransport({
      dial: other.dial,
      relayKey: createIdentity(seed(99)).unwrap().peerId,
      reconnectMs: 5,
      forceReadyAfter: 20,
    });
    wrong.onLinkEvent?.((event) => void seen.push(event));
    await wrong.start(b.context);
    await wrong.whenReady();
    await tick(40);
    expect(seen.find((e) => e.kind === "refused")?.why).toMatch(/signed by a key other than/);
    expect(other.dials()).toBe(1);
    expect(room.clients()).toBe(1); // a is still seated, and b never sat down
    await wrong.stop();
    await pinned.stop();
    room.close();
  });
});

import type { PartitionKey } from "@syncmesh/kernel";

import { entitledInterest, interestText } from "@syncmesh/engine";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { Temporal } from "@syncmesh/temporal";
import { grantFrame } from "@syncmesh/transport";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { RelayRoomOptions } from "../room.js";

import { joinFrame } from "../frames.js";
import { relayTransport } from "../transport.js";
import { REGRANTED, REVOKED, UNGRANTED } from "../trust.js";
import {
  ACME,
  GLOBEX,
  ISSUER,
  T0,
  bodyOf,
  challengeOf,
  dialTo,
  fakeSocket,
  mintFor,
  openRoom,
  peer,
  signedJoin,
  tick,
  until,
  write,
} from "./fixtures.js";

/** A room that seats only devices holding a grant from {@link ISSUER} (D40), on a clock the test owns. */
const gatedRoom = (overrides: Partial<RelayRoomOptions> = {}) =>
  openRoom({
    pageSize: 100,
    now: () => T0,
    trust: { issuers: [ISSUER.peerId], wait: Temporal.Duration.from({ milliseconds: 60 }) },
    ...overrides,
  });

const later = (ms: number) => T0.add({ milliseconds: ms });

/** Whether a device's log holds any event of a partition — not a row, not a parked event, nothing. */
const holds = async (device: ReturnType<typeof peer>, partition: PartitionKey) =>
  (await device.engine.eventsSince(new Map()))
    .unwrap()
    .some((e) => e.event.partition === partition);

/** The author: granted both partitions, writing one row in each, on the room before anyone else. */
const authorIn = async (room: Awaited<ReturnType<typeof gatedRoom>>) => {
  const author = peer(40, "acct_author");
  const t = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
  await t.start(author.context);
  await t.whenReady();
  await tick(20);
  return { author, t };
};

describe("a grant-gated room (D40)", () => {
  test("serves a device only the partitions its grant names — catch-up and live alike", async () => {
    const room = await gatedRoom();
    const { author, t: ta } = await authorIn(room);
    await write(author, "a1", "acme one", ACME);
    await write(author, "g1", "globex secret", GLOBEX);
    await write(author, "a2", "acme two", ACME);
    await tick(30);

    const reader = peer(41, "acct_reader", 100, { partitions: [ACME] });
    const tr = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await tr.start(reader.context);
    await tr.whenReady();
    expect(await until(() => bodyOf(reader, "a2") === "acme two")).toBe(true);
    expect(bodyOf(reader, "a1")).toBe("acme one");
    expect(bodyOf(reader, "g1")).toBeUndefined();
    // the coverage names the entitlement, not the interest, so a wider grant later re-pages
    expect(reader.engine.coverage().scope).toBe(interestText(entitledInterest(undefined, [ACME])));

    // live: a globex write never reaches it, and the acme write after it still folds — the hole
    // the gate leaves in the author's run is accounted for, not a stall
    await write(author, "g2", "globex live", GLOBEX);
    await write(author, "a3", "acme three", ACME);
    expect(await until(() => bodyOf(reader, "a3") === "acme three")).toBe(true);
    expect(bodyOf(reader, "g2")).toBeUndefined();
    expect(await holds(reader, GLOBEX)).toBe(false);

    await ta.stop();
    await tr.stop();
    room.close();
  });

  test("a device with no grant is refused as ungranted and is sent no event", async () => {
    const room = await gatedRoom();
    const { author, t: ta } = await authorIn(room);
    await write(author, "a1", "acme one", ACME);
    await tick(20);

    const stranger = peer(42, "acct_stranger", 100, { granted: false });
    const ts = relayTransport({ dial: dialTo(room).dial, reconnectMs: 1000 });
    await ts.start(stranger.context);
    await tick(150);
    expect(bodyOf(stranger, "a1")).toBeUndefined();
    expect((await stranger.engine.eventsSince(new Map())).unwrap()).toHaveLength(0);

    await ta.stop();
    await ts.stop();
    room.close();
  });

  test("the refusal is the typed `ungranted`, sent before the socket closes, and no page comes first", async () => {
    const room = await gatedRoom({ versions: [2] });
    const socket = fakeSocket();
    const conn = room.connect(socket.socket);
    const stranger = createIdentity(seed(43)).unwrap();
    conn.receive(signedJoin(stranger, challengeOf(socket)));
    await tick(120);
    expect(socket.ofKind("hello")).toHaveLength(0);
    expect(socket.ofKind("page")).toHaveLength(0);
    expect(socket.ofKind("error").map((f) => f.code)).toEqual([UNGRANTED]);
    expect(socket.closedWith).toEqual([UNGRANTED]);
    room.close();
  });

  test("a grant from an issuer the room does not trust seats nobody", async () => {
    const room = await gatedRoom({ versions: [2] });
    const rogue = createIdentity(seed(99)).unwrap();
    const device = createIdentity(seed(44)).unwrap();
    const forged = issueGrant(rogue, {
      account: "acct_x",
      device: device.peerId,
      partitions: [ACME, GLOBEX],
      validFor: Temporal.Duration.from({ days: 1 }),
      now: T0,
    });
    const socket = fakeSocket();
    const conn = room.connect(socket.socket);
    conn.receive(signedJoin(device, challengeOf(socket)));
    conn.receive(grantFrame(forged));
    await tick(120);
    expect(socket.ofKind("hello")).toHaveLength(0);
    expect(socket.ofKind("error").map((f) => f.code)).toEqual([UNGRANTED]);
    room.close();
  });

  test("a bare join naming a granted device is refused unproven, never seated under its grant", async () => {
    // an operator listing 1 takes a bare join on trust in an open room; a gated room cannot,
    // because the seat is the grant the room holds for whichever key the join names
    const room = await gatedRoom({ versions: [1] });
    const device = createIdentity(seed(50)).unwrap();
    const owner = fakeSocket();
    const own = room.connect(owner.socket);
    own.receive(signedJoin(device, challengeOf(owner), new Map(), undefined, [1, 2]));
    own.receive(grantFrame(mintFor(device, "acct_d")));
    await tick(20);
    expect(owner.ofKind("hello")).toHaveLength(1);

    const impostor = fakeSocket();
    room.connect(impostor.socket).receive(joinFrame([1], device.peerId, new Map()));
    await tick(20);
    expect(impostor.ofKind("hello")).toHaveLength(0);
    expect(impostor.ofKind("page")).toHaveLength(0);
    expect(impostor.ofKind("error").map((f) => f.code)).toEqual(["unproven"]);
    room.close();
  });

  test("a forged later grant cannot evict a device's real one", async () => {
    const room = await gatedRoom();
    const { author, t: ta } = await authorIn(room);
    await write(author, "a1", "acme one", ACME);
    await tick(20);
    const reader = peer(45, "acct_reader", 100, { partitions: [ACME] });
    const tr = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await tr.start(reader.context);
    await tr.whenReady();
    expect(await until(() => bodyOf(reader, "a1") === "acme one")).toBe(true);

    // a stranger mints a "newer" grant for the reader, signed by nobody the room trusts
    const rogue = createIdentity(seed(98)).unwrap();
    const forged = issueGrant(rogue, {
      account: "acct_reader",
      device: reader.identity.peerId,
      partitions: [],
      validFor: Temporal.Duration.from({ days: 1 }),
      now: later(60_000),
    });
    const socket = fakeSocket();
    const conn = room.connect(socket.socket);
    conn.receive(grantFrame(forged));
    await write(author, "a2", "acme two", ACME);
    expect(await until(() => bodyOf(reader, "a2") === "acme two")).toBe(true);

    await ta.stop();
    await tr.stop();
    room.close();
  });
});

describe("revocation at the room (D40)", () => {
  /** A reader granted both partitions, caught up on a room whose author writes in both. */
  const caughtUpReader = async () => {
    const room = await gatedRoom();
    const { author, t: ta } = await authorIn(room);
    await write(author, "a1", "acme one", ACME);
    await write(author, "g1", "globex one", GLOBEX);
    await tick(20);
    const reader = peer(46, "acct_reader");
    const tr = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await tr.start(reader.context);
    await tr.whenReady();
    expect(await until(() => bodyOf(reader, "g1") === "globex one")).toBe(true);
    return { room, author, ta, reader, tr };
  };

  const narrowed = (
    partitions: readonly PartitionKey[],
    at: number,
    device: ReturnType<typeof peer>,
  ) => mintFor(device.identity, "acct_reader", { partitions, now: later(at) });

  test("a narrower grant closes the reader's socket; after it re-joins, nothing of the dropped partition reaches it", async () => {
    const { room, author, ta, reader, tr } = await caughtUpReader();
    // the authority re-issues the reader's grant without globex; it travels to the room
    author.grants.register(narrowed([ACME], 1000, reader)).unwrap();
    expect(
      await until(() => reader.grants.grantFor(reader.identity.peerId)?.partitions.length === 1),
    ).toBe(true);
    await write(author, "g2", "globex after", GLOBEX);
    await write(author, "a2", "acme after", ACME);
    expect(await until(() => bodyOf(reader, "a2") === "acme after")).toBe(true);
    await tick(50);
    expect(bodyOf(reader, "g2")).toBeUndefined();
    // the only globex event it holds is the one written before the cut
    const globex = (await reader.engine.eventsSince(new Map()))
      .unwrap()
      .filter((e) => e.event.partition === GLOBEX);
    expect(globex).toHaveLength(1);
    // what it read before the cut it keeps: no scheme undoes a read
    expect(bodyOf(reader, "g1")).toBe("globex one");

    await ta.stop();
    await tr.stop();
    room.close();
  });

  test("the socket is told why: revoked for a narrower grant, regranted for a wider one", async () => {
    const room = await gatedRoom({ versions: [2] });
    const device = createIdentity(seed(47)).unwrap();

    const first = fakeSocket();
    const one = room.connect(first.socket);
    one.receive(signedJoin(device, challengeOf(first)));
    one.receive(grantFrame(mintFor(device, "acct_d", { partitions: [ACME, GLOBEX] })));
    await tick(20);
    expect(first.ofKind("hello")).toHaveLength(1);
    one.receive(grantFrame(mintFor(device, "acct_d", { partitions: [ACME], now: later(1000) })));
    expect(first.ofKind("error").map((f) => f.code)).toEqual([REVOKED]);

    const second = fakeSocket();
    const two = room.connect(second.socket);
    two.receive(signedJoin(device, challengeOf(second)));
    await tick(20);
    // seated straight away under the grant the room already holds
    expect(second.ofKind("hello")).toHaveLength(1);
    two.receive(
      grantFrame(mintFor(device, "acct_d", { partitions: [ACME, GLOBEX], now: later(2000) })),
    );
    expect(second.ofKind("error").map((f) => f.code)).toEqual([REGRANTED]);
    room.close();
  });

  test("a wider grant re-pages what the narrower one kept out", async () => {
    const room = await gatedRoom();
    const { author, t: ta } = await authorIn(room);
    await write(author, "a1", "acme one", ACME);
    await write(author, "g1", "globex one", GLOBEX);
    await tick(20);
    const reader = peer(48, "acct_reader", 100, { partitions: [ACME] });
    const tr = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await tr.start(reader.context);
    await tr.whenReady();
    expect(await until(() => bodyOf(reader, "a1") === "acme one")).toBe(true);
    expect(bodyOf(reader, "g1")).toBeUndefined();

    author.grants
      .register(
        mintFor(reader.identity, "acct_reader", { partitions: [ACME, GLOBEX], now: later(1000) }),
      )
      .unwrap();
    expect(await until(() => bodyOf(reader, "g1") === "globex one")).toBe(true);

    await ta.stop();
    await tr.stop();
    room.close();
  });

  test("a grant that lapses stops fan-out to its socket and hangs up", async () => {
    let now = T0;
    const room = await gatedRoom({ now: () => now });
    const { author, t: ta } = await authorIn(room);
    const reader = peer(49, "acct_reader");
    const tr = relayTransport({ dial: dialTo(room).dial, reconnectMs: 5000 });
    await tr.start(reader.context);
    await tr.whenReady();
    await write(author, "a1", "acme one", ACME);
    expect(await until(() => bodyOf(reader, "a1") === "acme one")).toBe(true);

    // a day and a minute on: the author's own grant is past too, but its write still reaches the
    // room — the gate is on reading, and this socket's ticket has run out
    now = T0.add({ hours: 24, minutes: 1 });
    await write(author, "a2", "acme two", ACME);
    await tick(80);
    expect(bodyOf(reader, "a2")).toBeUndefined();

    await ta.stop();
    await tr.stop();
    room.close();
  });
});

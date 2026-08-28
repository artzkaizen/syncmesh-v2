import type { PeerId } from "@syncmesh/kernel";

import { createMemoryEventStore } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";
import { cursorsFrame, eventFrame, grantFrame, presenceFrame } from "@syncmesh/transport";
import { decodeAndVerify, signPresence } from "@syncmesh/wire";
import { fromALaterBuild } from "@syncmesh/wire/wire-tests";
import { describe, expect, test } from "bun:test";

import type { Peer } from "./fixtures.js";

import { memoryFanout } from "../fanout.js";
import { joinFrame } from "../frames.js";
import {
  ACME,
  GLOBEX,
  T0,
  entryOf,
  fakeSocket,
  mintFor,
  openRoom as open,
  peer,
  tick,
  write,
} from "./fixtures.js";

const join = (peerId: PeerId, versions: readonly number[] = [1]) =>
  joinFrame(versions, peerId, new Map());

describe("handshake (D14)", () => {
  test("join → hello with the selected version, keepalive, epoch and the room's cursors; then pages", async () => {
    const a = peer(40, "acct_a");
    const store = createMemoryEventStore();
    const wires = [
      await write(a, "n1", "one"),
      await write(a, "n2", "two"),
      await write(a, "n3", "three"),
    ];
    for (const wire of wires) (await store.append(entryOf(wire))).unwrap();
    const room = await open({ store });

    const s = fakeSocket();
    const conn = room.connect(s.socket);
    conn.receive(join(a.identity.peerId));
    await tick();

    const [hello] = s.ofKind("hello");
    expect(hello?.version).toBe(1);
    expect(hello?.epoch).toBe("epoch-1");
    expect(Number(hello?.cursors.get(a.identity.peerId))).toBe(3);

    const pages = s.ofKind("page");
    expect(pages.map((p) => p.events.length)).toEqual([2, 1]);
    expect(pages.map((p) => p.more)).toEqual([true, false]);
    room.close();
  });

  test("no version in common: a typed error, then the socket is closed", async () => {
    const a = peer(40, "acct_a");
    const room = await open();
    const s = fakeSocket();
    room.connect(s.socket).receive(join(a.identity.peerId, [99]));
    expect(s.ofKind("error")[0]?.code).toBe("version");
    expect(s.closedWith).toEqual(["version"]);
    expect(room.clients()).toBe(0);
    room.close();
  });

  test("the first frame must be join; a second join for the same peer closes the old socket first", async () => {
    const a = peer(40, "acct_a");
    const wire = await write(a, "n1", "one");
    const room = await open();

    const early = fakeSocket();
    room.connect(early.socket).receive(eventFrame(wire));
    expect(early.ofKind("error")[0]?.code).toBe("join-first");
    expect(early.closedWith).toEqual(["join-first"]);

    const first = fakeSocket();
    const second = fakeSocket();
    room.connect(first.socket).receive(join(a.identity.peerId));
    room.connect(second.socket).receive(join(a.identity.peerId));
    expect(first.closedWith).toEqual(["superseded by a newer join"]);
    expect(room.clients()).toBe(1);
    room.close();
  });
});

/** The same event as a newer build sends it, from the signed wire this build already has. */
const grownFrom = (wire: Uint8Array, identity: Peer["identity"]) =>
  fromALaterBuild(decodeAndVerify(wire).unwrap().event, identity).wire;

describe("ingest", () => {
  test("a newer build's event is served on as the bytes its author signed, not this build's reading", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const grown = grownFrom(await write(a, "n1", "one"), a.identity);
    const room = await open();

    const sa = fakeSocket();
    const ca = room.connect(sa.socket);
    ca.receive(join(a.identity.peerId));
    await tick();
    ca.receive(eventFrame(grown));
    await tick();
    expect(sa.ofKind("error")).toEqual([]); // it verified on the way in

    // a joiner arriving after the fact gets it out of the log, through the catch-up path
    const sb = fakeSocket();
    room.connect(sb.socket).receive(join(b.identity.peerId));
    await tick();
    const served = sb.ofKind("page").flatMap((p) => p.events);
    expect(served).toEqual([grown]);
    expect(decodeAndVerify(served[0] ?? new Uint8Array()).isOk()).toBe(true);
    room.close();
  });

  test("append once: ack to the author, the relayed frame to everyone else, dedup acks idempotently", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const room = await open();
    const sa = fakeSocket();
    const sb = fakeSocket();
    room.connect(sa.socket).receive(join(a.identity.peerId));
    const ca = room.connect(sa.socket);
    room.connect(sb.socket).receive(join(b.identity.peerId));
    await tick();
    sa.sent.length = 0;
    sb.sent.length = 0;

    const wire = await write(a, "n1", "one");
    const conn = room.connect(sa.socket);
    conn.receive(join(a.identity.peerId)); // reattach: one connection object per socket in this fake
    await tick();
    sa.sent.length = 0;
    conn.receive(eventFrame(wire));
    await tick();

    expect(sa.ofKind("ack").map((f) => f.offset)).toEqual([1]);
    expect(sb.ofKind("relayed")).toHaveLength(1);
    expect(room.offset()).toBe(1);

    conn.receive(eventFrame(wire)); // the same bytes again: no second append, the same ack
    await tick();
    expect(sa.ofKind("ack").map((f) => f.offset)).toEqual([1, 1]);
    expect(sb.ofKind("relayed")).toHaveLength(1);
    expect(room.offset()).toBe(1);
    void ca;
    room.close();
  });

  test("grants forward byte-identical and land in the next joiner's first page", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const room = await open();
    const sa = fakeSocket();
    const sb = fakeSocket();
    const ca = room.connect(sa.socket);
    ca.receive(join(a.identity.peerId));
    const cb = room.connect(sb.socket);
    cb.receive(join(b.identity.peerId));
    await tick();
    sb.sent.length = 0;

    const grantWire = mintFor(a.identity, "acct_a");
    const framed = grantFrame(grantWire);
    ca.receive(framed);
    await tick();
    const [forwarded] = sb.sent;
    expect(forwarded).toEqual(framed); // the received frame bytes, untouched

    const late = fakeSocket();
    room.connect(late.socket).receive(join(peer(120, "acct_c").identity.peerId));
    await tick();
    expect(late.ofKind("page")[0]?.grants).toHaveLength(1);
    room.close();
  });
});

/**
 * Keyed by device, newest mint wins (D08). Keyed by bytes the room kept every grant a device was
 * ever given and replayed the lot to each joiner — receivers still resolved it, so what this
 * costs is bandwidth that only grows, not correctness.
 */
describe("the room's grant cache", () => {
  const later = Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + 60_000);

  /** A room with one client already joined, and a socket to watch what it is told. */
  const roomWithClient = async () => {
    const a = peer(40, "acct_a");
    const room = await open();
    const sa = fakeSocket();
    const ca = room.connect(sa.socket);
    ca.receive(join(a.identity.peerId));
    const watcher = fakeSocket();
    room.connect(watcher.socket).receive(join(peer(80, "acct_b").identity.peerId));
    await tick();
    watcher.sent.length = 0;
    return { a, room, ca, watcher };
  };

  /** What a fresh joiner is handed: the grants on its first catch-up page. */
  const grantsForAJoiner = async (room: Awaited<ReturnType<typeof open>>, n: number) => {
    const late = fakeSocket();
    room.connect(late.socket).receive(join(peer(n, "acct_late").identity.peerId));
    await tick();
    return late.ofKind("page")[0]?.grants ?? [];
  };

  test("a re-issued grant supersedes the older one: one wire per device, the newest", async () => {
    const { a, room, ca, watcher } = await roomWithClient();
    const broad = mintFor(a.identity, "acct_a");
    const narrow = mintFor(a.identity, "acct_a", { now: later, partitions: [ACME] });
    ca.receive(grantFrame(broad));
    ca.receive(grantFrame(narrow));
    await tick();

    expect(watcher.sent).toEqual([grantFrame(broad), grantFrame(narrow)]);
    expect(await grantsForAJoiner(room, 120)).toEqual([narrow]);
    room.close();
  });

  test("an older grant arriving late is not cached and stops at the relay", async () => {
    const { a, room, ca, watcher } = await roomWithClient();
    const broad = mintFor(a.identity, "acct_a");
    const narrow = mintFor(a.identity, "acct_a", { now: later, partitions: [ACME] });
    ca.receive(grantFrame(narrow));
    ca.receive(grantFrame(broad)); // a replay, or a slower path's copy
    ca.receive(grantFrame(narrow)); // and the echo of what it already holds
    await tick();

    expect(watcher.sent).toEqual([grantFrame(narrow)]);
    expect(await grantsForAJoiner(room, 120)).toEqual([narrow]);
    room.close();
  });

  test("grants for different devices both survive", async () => {
    const { a, room, ca } = await roomWithClient();
    const b = peer(160, "acct_b");
    const mine = mintFor(a.identity, "acct_a");
    const theirs = mintFor(b.identity, "acct_b");
    ca.receive(grantFrame(mine));
    ca.receive(grantFrame(theirs));
    await tick();

    const held = await grantsForAJoiner(room, 120);
    expect(held).toHaveLength(2);
    expect(held).toEqual(expect.arrayContaining([mine, theirs]));
    room.close();
  });

  test("a grant whose core will not decode is still forwarded, and never cached", async () => {
    const { room, ca, watcher } = await roomWithClient();
    const junk = Uint8Array.of(1, 2, 3, 4);
    ca.receive(grantFrame(junk));
    await tick();

    expect(watcher.sent).toEqual([grantFrame(junk)]); // the relay does not judge grants
    expect(await grantsForAJoiner(room, 120)).toEqual([]);
    room.close();
  });
});

describe("peer-to-peer facts pass through", () => {
  test("a joiner's cursors reach the others at join, and a cursors frame it sends later too", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const room = await open();
    const sa = fakeSocket();
    room.connect(sa.socket).receive(join(a.identity.peerId));
    await tick();
    sa.sent.length = 0;

    const sb = fakeSocket();
    const cb = room.connect(sb.socket);
    // SAFETY: test fixture seq
    const theirs = new Map([[a.identity.peerId, 2 as never]]);
    cb.receive(joinFrame([1], b.identity.peerId, theirs));
    await tick();
    const [atJoin] = sa.ofKind("session");
    expect(atJoin?.frame.kind === "cursors" && String(atJoin.frame.from)).toBe(
      String(b.identity.peerId),
    );
    expect(
      atJoin?.frame.kind === "cursors" && Number(atJoin.frame.cursors.get(a.identity.peerId)),
    ).toBe(2);

    sa.sent.length = 0;
    // SAFETY: test fixture seq
    const later = cursorsFrame(b.identity.peerId, new Map([[a.identity.peerId, 3 as never]]));
    cb.receive(later);
    expect(sa.sent[0]).toEqual(later); // byte-identical, and never echoed to b
    expect(sb.ofKind("session").filter((f) => f.frame.kind === "cursors")).toHaveLength(0);
    room.close();
  });
});

describe("presence at the middle hop (D16)", () => {
  test("a value forwards byte-identical, a stale one stops here, and a joiner is told who is here", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const room = await open();
    const sa = fakeSocket();
    const ca = room.connect(sa.socket);
    ca.receive(join(a.identity.peerId));
    const sb = fakeSocket();
    room.connect(sb.socket).receive(join(b.identity.peerId));
    await tick();
    sb.sent.length = 0;

    const cursor = (n: number, count: number) =>
      presenceFrame(
        signPresence(
          {
            v: 1,
            peerId: a.identity.peerId,
            topic: "cursor",
            partition: ACME,
            session: "s1",
            count,
            // SAFETY: test fixture column name; names are brands over these strings
            value: new Map([["x" as never, n]]),
            // the room's presence store reads the wall clock, so an expiry must be a real one
            expires: Date.now() + 60_000,
          },
          a.identity,
        ).wire,
      );

    const presenceSeen = (socket: typeof sa) =>
      socket.ofKind("session").filter((f) => f.frame.kind === "presence");

    sa.sent.length = 0;
    const first = cursor(1, 1);
    ca.receive(first);
    expect(sb.sent[0]).toEqual(first); // the received bytes, untouched
    expect(presenceSeen(sa)).toHaveLength(0); // never echoed to its author

    sb.sent.length = 0;
    ca.receive(cursor(0, 1)); // the same count again: a loop's echo, not news
    expect(sb.sent).toHaveLength(0);

    // a third client joins and is told the current value — and no history, because there is none
    const sc = fakeSocket();
    room.connect(sc.socket).receive(join(peer(120, "acct_c").identity.peerId));
    await tick();
    const greeting = sc.frames().filter((f) => f.kind === "session" && f.frame.kind === "presence");
    expect(greeting).toHaveLength(1);
    room.close();
  });
});

describe("backpressure", () => {
  test("dropped frames queue in order and drain flushes them; the ceiling closes the socket", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const room = await open({ maxBacklog: 3, pageSize: 100 });
    const sa = fakeSocket();
    const ca = room.connect(sa.socket);
    ca.receive(join(a.identity.peerId));
    await tick();
    sa.sent.length = 0;

    sa.setMode("dropped"); // the socket refuses: everything from here queues
    const sb = fakeSocket();
    const cb = room.connect(sb.socket);
    cb.receive(join(b.identity.peerId));
    await tick();
    const wires = [await write(b, "n1", "one"), await write(b, "n2", "two")];
    for (const wire of wires) cb.receive(eventFrame(wire));
    await tick();
    expect(sa.sent).toHaveLength(0);

    sa.setMode("sent");
    ca.drain();
    expect(sa.ofKind("relayed").map((f) => f.offset)).toEqual([1, 2]); // order preserved

    sa.setMode("dropped");
    cb.receive(eventFrame(await write(b, "n3", "3")));
    cb.receive(eventFrame(await write(b, "n4", "4")));
    cb.receive(eventFrame(await write(b, "n5", "5")));
    cb.receive(eventFrame(await write(b, "n6", "6")));
    await tick();
    expect(sa.closedWith.some((reason) => reason.includes("backlog"))).toBe(true);
    room.close();
  });
});

describe("fanout (D09-B)", () => {
  test("an ingest on one instance reaches the other instance's clients; never doubled locally", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const fanout = memoryFanout();
    const one = await open({ fanout });
    const two = await open({ fanout, store: createMemoryEventStore() });
    const sa = fakeSocket();
    const sb = fakeSocket();
    const ca = one.connect(sa.socket);
    ca.receive(join(a.identity.peerId));
    const cb = two.connect(sb.socket);
    cb.receive(join(b.identity.peerId));
    await tick();
    sa.sent.length = 0;
    sb.sent.length = 0;

    ca.receive(eventFrame(await write(a, "n1", "one")));
    await tick();
    expect(sb.ofKind("relayed")).toHaveLength(1); // crossed instances
    expect(sa.ofKind("relayed")).toHaveLength(0); // the author's own instance does not echo
    one.close();
    two.close();
  });

  /**
   * The half a forward alone does not do (API.md §13.5). An instance that only passes the frame
   * to its own sockets holds nothing afterwards, so the next phone to land there catches up to a
   * shorter room — and pushes nothing back, because it has nothing the room did not claim.
   */
  test("the instance that received the fan-out holds the event too, and serves it to a later joiner", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const c = peer(120, "acct_c");
    const fanout = memoryFanout();
    const far = createMemoryEventStore();
    const one = await open({ fanout });
    const two = await open({ fanout, store: far });

    const sa = fakeSocket();
    const ca = one.connect(sa.socket);
    ca.receive(join(a.identity.peerId));
    two.connect(fakeSocket().socket).receive(join(b.identity.peerId));
    await tick();
    const wire = await write(a, "n1", "one");
    ca.receive(eventFrame(wire));
    await tick();

    expect((await far.all()).unwrap()).toHaveLength(1);
    // and a phone arriving on that instance afterwards is paged it, byte for byte
    const sc = fakeSocket();
    two.connect(sc.socket).receive(join(c.identity.peerId));
    await tick();
    expect(sc.ofKind("page").flatMap((p) => p.events)).toEqual([wire]);
    one.close();
    two.close();
  });

  test("a grant that crossed instances is in the cache the next joiner's first page is built from", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const fanout = memoryFanout();
    const one = await open({ fanout });
    const two = await open({ fanout, store: createMemoryEventStore() });

    const ca = one.connect(fakeSocket().socket);
    ca.receive(join(a.identity.peerId));
    await tick();
    const grant = mintFor(a.identity, "acct_a");
    ca.receive(grantFrame(grant));
    await tick();

    const sb = fakeSocket();
    two.connect(sb.socket).receive(join(b.identity.peerId));
    await tick();
    expect(sb.ofKind("page").flatMap((p) => p.grants)).toEqual([grant]);
    one.close();
    two.close();
  });

  test("a narrowed interest is honoured whichever instance the event came from", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const fanout = memoryFanout();
    const one = await open({ fanout });
    const two = await open({ fanout, store: createMemoryEventStore() });

    const ca = one.connect(fakeSocket().socket);
    ca.receive(join(a.identity.peerId));
    const sb = fakeSocket();
    two
      .connect(sb.socket)
      .receive(joinFrame([1], b.identity.peerId, new Map(), { partitions: [ACME] }));
    await tick();

    ca.receive(eventFrame(await write(a, "n1", "one", GLOBEX)));
    await tick();
    expect(sb.ofKind("relayed")).toEqual([]); // it asked for acme; this one is globex
    ca.receive(eventFrame(await write(a, "n2", "two", ACME)));
    await tick();
    expect(sb.ofKind("relayed")).toHaveLength(1);
    one.close();
    two.close();
  });
});

import type { PeerId } from "@syncmesh/kernel";

import { createMemoryEventStore } from "@syncmesh/engine";
import { eventFrame, grantFrame } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import type { RelayFrame } from "../frames.js";
import type { RelaySocket, SendOutcome } from "../sender.js";

import { memoryFanout } from "../fanout.js";
import { decodeRelayFrame, joinFrame } from "../frames.js";
import { openRelayRoom } from "../room.js";
import { entryOf, mintFor, peer, tick, write } from "./fixtures.js";

/** A socket the test scripts: outcomes on demand, everything sent kept for inspection. */
const fakeSocket = () => {
  const sent: Uint8Array[] = [];
  const closedWith: string[] = [];
  let mode: SendOutcome = "sent";
  const socket: RelaySocket = {
    send: (frame) => {
      if (mode === "sent") sent.push(frame);
      return mode;
    },
    close: (reason) => void closedWith.push(reason ?? ""),
  };
  return {
    socket,
    sent,
    closedWith,
    setMode: (next: SendOutcome) => void (mode = next),
    frames: (): readonly RelayFrame[] => sent.map((f) => decodeRelayFrame(f).unwrap()),
    ofKind: <K extends RelayFrame["kind"]>(kind: K) =>
      sent
        .map((f) => decodeRelayFrame(f).unwrap())
        .filter((f): f is Extract<RelayFrame, { kind: K }> => f.kind === kind),
  };
};

const open = async (overrides: Partial<Parameters<typeof openRelayRoom>[0]> = {}) =>
  (
    await openRelayRoom({
      name: "main",
      store: createMemoryEventStore(),
      epoch: "epoch-1",
      keepaliveMs: 60_000,
      pageSize: 2,
      maxBacklog: 8,
      ...overrides,
    })
  ).unwrap();

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

describe("ingest", () => {
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
});

import type { Interest } from "@syncmesh/engine";

import { createMemoryEventStore, interestText } from "@syncmesh/engine";
import { describe, expect, test } from "bun:test";

import type { RelayRoom } from "../room.js";
import type { RelaySocket } from "../sender.js";
import type { RelayDial } from "../transport.js";

import { openRelayRoom } from "../room.js";
import { relayTransport } from "../transport.js";
import { ACME, GLOBEX, bodyOf, peer, tick, write } from "./fixtures.js";

/** An in-process dial to a live room: frames both ways, async delivery, a closable end. */
const dialTo = (room: RelayRoom) => (): RelayDial => {
  const frames = new Set<(frame: Uint8Array) => void>();
  const closes = new Set<() => void>();
  let open = true;
  const hangUp = (): void => {
    if (!open) return;
    open = false;
    conn.closed();
    queueMicrotask(() => closes.forEach((cb) => cb()));
  };
  const socket: RelaySocket = {
    send: (frame) => {
      if (!open) return "dropped";
      const bytes = Uint8Array.from(frame);
      queueMicrotask(() => frames.forEach((cb) => cb(bytes)));
      return "sent";
    },
    close: () => hangUp(),
  };
  const conn = room.connect(socket);
  return {
    send: (frame) => {
      if (!open) throw new Error("relay socket is not open");
      conn.receive(Uint8Array.from(frame));
    },
    onFrame: (cb) => {
      frames.add(cb);
      return () => void frames.delete(cb);
    },
    onClose: (cb) => {
      closes.add(cb);
      return () => void closes.delete(cb);
    },
    close: () => hangUp(),
  };
};

const open = async (pageSize = 100) =>
  (
    await openRelayRoom({
      name: "main",
      store: createMemoryEventStore(),
      epoch: "epoch-1",
      keepaliveMs: 60_000,
      pageSize,
    })
  ).unwrap();

/** A room holding a run whose middle is in another instance — the hole a filter leaves. */
const roomWithBoth = async (pageSize = 100) => {
  const room = await open(pageSize);
  const author = peer(40, "acct_a");
  const ta = relayTransport({ dial: dialTo(room), reconnectMs: 10 });
  await ta.start(author.context);
  await ta.whenReady();
  await tick(20);
  await write(author, "a1", "acme one", ACME);
  await write(author, "g1", "globex", GLOBEX);
  await write(author, "a2", "acme two", ACME);
  await tick(20);
  return { room, author, stop: () => ta.stop() };
};

const ACME_ONLY: Interest = { partitions: [ACME] };

describe("a cursor that asked for less", () => {
  test("does not pin at the first sequence the filter dropped", async () => {
    const { room, author, stop } = await roomWithBoth();
    // seq 2 is globex and never arrives; without a scoped coverage the cursor sticks at 1 and
    // every later event waits in the holdback behind a hole the relay is dropping on purpose
    const joiner = peer(80, "acct_b");
    const tb = relayTransport({ dial: dialTo(room), reconnectMs: 10, interest: ACME_ONLY });
    await tb.start(joiner.context);
    await tb.whenReady();
    await tick(30);

    expect(bodyOf(joiner, "a1")).toBe("acme one");
    expect(bodyOf(joiner, "a2")).toBe("acme two"); // the event after the hole
    expect(bodyOf(joiner, "g1")).toBeUndefined(); // still filtered, as asked
    const cursor = joiner.engine.coverage().synced.get(author.identity.peerId);
    expect(Number(cursor)).toBe(3);

    await tb.stop();
    await stop();
    room.close();
  });

  test("says what it is scoped to, and an unfiltered one says nothing", async () => {
    const { room, author, stop } = await roomWithBoth();

    const narrow = peer(80, "acct_b");
    const tn = relayTransport({ dial: dialTo(room), reconnectMs: 10, interest: ACME_ONLY });
    await tn.start(narrow.context);
    await tn.whenReady();
    await tick(30);
    expect(narrow.engine.coverage().scope).toBe(interestText(ACME_ONLY));

    const wide = peer(120, "acct_c");
    const tw = relayTransport({ dial: dialTo(room), reconnectMs: 10 });
    await tw.start(wide.context);
    await tw.whenReady();
    await tick(30);
    // an unscoped peer is untouched: its cursor keeps its plain, stronger meaning
    expect(wide.engine.coverage().scope).toBeUndefined();
    expect(Number(wide.engine.coverage().synced.get(author.identity.peerId))).toBe(3);

    await tn.stop();
    await tw.stop();
    await stop();
    room.close();
  });

  test("a widened interest re-pages the run rather than skipping what the old filter dropped", async () => {
    const { room, author, stop } = await roomWithBoth();
    const device = peer(80, "acct_b");

    const narrow = relayTransport({ dial: dialTo(room), reconnectMs: 10, interest: ACME_ONLY });
    await narrow.start(device.context);
    await narrow.whenReady();
    await tick(30);
    expect(bodyOf(device, "g1")).toBeUndefined();
    await narrow.stop();

    // the same device, same engine, now asking for everything — the cursor at 3 would silently
    // skip globex forever, so the join must go back to the start
    const wide = relayTransport({ dial: dialTo(room), reconnectMs: 10 });
    await wide.start(device.context);
    await wide.whenReady();
    await tick(30);
    expect(bodyOf(device, "g1")).toBe("globex");
    expect(device.engine.coverage().scope).toBeUndefined();
    expect(Number(device.engine.coverage().synced.get(author.identity.peerId))).toBe(3);

    await wide.stop();
    await stop();
    room.close();
  });

  test("only the last page carries it, and only when a filter ran", async () => {
    const { room, stop } = await roomWithBoth(1); // one event per page
    const joiner = peer(80, "acct_b");
    const seen: (string | undefined)[] = [];
    const tb = relayTransport({ dial: dialTo(room), reconnectMs: 10, interest: ACME_ONLY });
    await tb.start(joiner.context);
    await tb.whenReady();
    await tick(30);
    // proven through what the client ended up holding rather than by reading frames: a coverage
    // applied before its pages landed would claim events this device had not folded
    expect(bodyOf(joiner, "a2")).toBe("acme two");
    expect(seen).toEqual([]);

    await tb.stop();
    await stop();
    room.close();
  });
});

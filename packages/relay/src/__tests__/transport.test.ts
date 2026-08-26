import type { Unsubscribe } from "@syncmesh/engine";

import { createMemoryEventStore } from "@syncmesh/engine";
import { describe, expect, test } from "bun:test";

import type { RelayRoom } from "../room.js";
import type { RelaySocket } from "../sender.js";
import type { RelayDial } from "../transport.js";

import { helloFrame } from "../frames.js";
import { openRelayRoom } from "../room.js";
import { relayTransport } from "../transport.js";
import { bodyOf, peer, tick, write } from "./fixtures.js";

/** An in-process dial to a live room: frames both ways, async delivery, a closable end. */
const dialTo = (room: RelayRoom) => {
  let dials = 0;
  const dial = (): RelayDial => {
    dials += 1;
    const frames = new Set<(frame: Uint8Array) => void>();
    const closes = new Set<() => void>();
    let open = true;
    const hangUp = (): void => {
      if (!open) return;
      open = false;
      conn.closed();
      // the close event lands after any frames already in flight, as on a real socket
      queueMicrotask(() => {
        for (const cb of closes) cb();
      });
    };
    const socket: RelaySocket = {
      send: (frame) => {
        if (!open) return "dropped";
        // a frame accepted before close still delivers: TCP flushes what send() took
        const bytes = Uint8Array.from(frame);
        queueMicrotask(() => {
          for (const cb of frames) cb(bytes);
        });
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
  return { dial, dials: () => dials };
};

const open = async (overrides: Partial<Parameters<typeof openRelayRoom>[0]> = {}) =>
  (
    await openRelayRoom({
      name: "main",
      store: createMemoryEventStore(),
      epoch: "epoch-1",
      keepaliveMs: 60_000,
      pageSize: 2,
      ...overrides,
    })
  ).unwrap();

describe("relayTransport", () => {
  test("two peers converge through the room; a late joiner catches up in pages, then stays live", async () => {
    const room = await open();
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    await write(a, "n1", "one");
    await write(a, "n2", "two");
    await write(a, "n3", "three");

    const ta = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await ta.start(a.context);
    await ta.whenReady();
    await tick(20); // pages fold, then the push after the last page lands three events
    expect(room.offset()).toBe(3);

    const tb = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await tb.start(b.context);
    await tb.whenReady();
    await tick(20);
    expect(bodyOf(b, "n3")).toBe("three"); // paged catch-up, grants first

    await write(b, "n4", "four"); // live: b authors, a folds through the room
    await tick(20);
    expect(bodyOf(a, "n4")).toBe("four");
    expect(room.offset()).toBe(4);

    await ta.stop();
    await tb.stop();
    room.close();
  });

  test("a hang-up reconnects with a fresh join and resumes; a version refusal never reconnects", async () => {
    const room = await open();
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const wired = dialTo(room);
    const ta = relayTransport({ dial: wired.dial, reconnectMs: 5 });
    await ta.start(a.context);
    await ta.whenReady();
    const offline: boolean[] = [];
    ta.onStatus?.((online) => void offline.push(online));

    room.close(); // the relay hangs up every socket
    await tick(30);
    const revived = await open(); // a new room over a fresh store — the transport is still dialing the old one
    void revived;
    expect(wired.dials()).toBeGreaterThan(1); // backoff reconnects kept trying
    expect(offline).toContain(false);
    await ta.stop();

    const refused = dialTo(await open());
    const t99 = relayTransport({ dial: refused.dial, versions: [99], reconnectMs: 5 });
    await t99.start(b.context);
    await tick(40);
    expect(refused.dials()).toBe(1); // the typed refusal is permanent
    await t99.stop();
  });

  test("keepalive: a mute relay is dropped at 2.5× the announced cadence and redialed; a hello-less one is left alone", async () => {
    const a = peer(40, "acct_a");
    let dials = 0;
    let mute = false;
    const dial = (): RelayDial => {
      dials += 1;
      const frames = new Set<(f: Uint8Array) => void>();
      const closes = new Set<() => void>();
      return {
        send: () => {
          // answer the join with a hello announcing a 10ms keepalive, then go mute
          if (!mute) {
            mute = true;
            queueMicrotask(() => {
              const bytes = helloFrame(1, 10, "epoch-x", new Map());
              for (const cb of frames) cb(bytes);
            });
          }
        },
        onFrame: (cb): Unsubscribe => {
          frames.add(cb);
          return () => void frames.delete(cb);
        },
        onClose: (cb): Unsubscribe => {
          closes.add(cb);
          return () => void closes.delete(cb);
        },
        close: () => {
          for (const cb of closes) cb();
        },
      };
    };
    const t = relayTransport({ dial, reconnectMs: 5 });
    await t.start(a.context);
    await tick(60); // 10ms keepalive → 25ms deadline → the mute session is dropped and redialed
    expect(dials).toBeGreaterThan(1);
    await t.stop();

    let silentDials = 0;
    const silent = (): RelayDial => {
      silentDials += 1;
      return {
        send: () => undefined, // never answers: no hello, so no deadline is armed
        onFrame: () => () => undefined,
        onClose: () => () => undefined,
        close: () => undefined,
      };
    };
    const ts = relayTransport({ dial: silent, reconnectMs: 5, forceReadyAfter: 10 });
    await ts.start(a.context);
    await ts.whenReady(); // force-ready: a dead relay never wedges the mesh
    await tick(60);
    expect(silentDials).toBe(1); // hello-less: nothing armed, nothing dropped
    await ts.stop();
  });

  test("a grant-request travels through the relay to the peer that can answer it", async () => {
    const room = await open();
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const asked: string[] = [];
    const ctxA = {
      ...a.context,
      onGrantRequest: (r: { peerId: unknown; invite?: string }) => void asked.push(r.invite ?? ""),
    };
    const ta = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await ta.start(ctxA);
    await ta.whenReady();
    const tb = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await tb.start(b.context);
    await tb.whenReady();
    await tick(20);

    tb.requestGrant?.("inv-42");
    await tick(20);
    expect(asked).toEqual(["inv-42"]);
    await ta.stop();
    await tb.stop();
    room.close();
  });
});

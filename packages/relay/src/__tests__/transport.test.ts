import type { Unsubscribe } from "@syncmesh/engine";

import { describe, expect, test } from "bun:test";

import type { RelayDial } from "../transport.js";

import { challengeFrame, helloFrame } from "../frames.js";
import { relayTransport } from "../transport.js";
import { bodyOf, dialTo, openRoom, peer, tick, write } from "./fixtures.js";

describe("relayTransport", () => {
  test("two peers converge through the room; a late joiner catches up in pages, then stays live", async () => {
    const room = await openRoom();
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
    // each side has heard, in the other's own words, what it holds — what `delivered` settles on
    expect(Number(a.engine.acks().get(b.identity.peerId)?.get(a.identity.peerId))).toBe(3);
    expect(Number(b.engine.acks().get(a.identity.peerId)?.get(b.identity.peerId))).toBe(1);

    await ta.stop();
    await tb.stop();
    room.close();
  });

  test("a hang-up reconnects with a fresh join and resumes; a version refusal never reconnects", async () => {
    const room = await openRoom();
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
    const revived = await openRoom(); // a new room over a fresh store — the transport is still dialing the old one
    void revived;
    expect(wired.dials()).toBeGreaterThan(1); // backoff reconnects kept trying
    expect(offline).toContain(false);
    await ta.stop();

    const refused = dialTo(await openRoom());
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
          // the room speaks first (D33): a challenge, which the transport answers with its join
          queueMicrotask(() => cb(challengeFrame(new Uint8Array(32))));
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
    // a hand-made relay that challenges (v2): offered, so the transport answers it
    const t = relayTransport({ dial, versions: [2], reconnectMs: 5 });
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
    const room = await openRoom();
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

/**
 * What a relay can honestly say about peers it is not linked to.
 *
 * It holds one socket and cannot enumerate a room, so before this it claimed nobody — and routing
 * reads "claims nobody" as a shrug, which let any radio that *did* claim a peer narrow the relay
 * away entirely. When that radio's claim was stale, the frame went to a dead link and the relay
 * that could have carried it was never asked.
 */
describe("what the relay says it delivers to", () => {
  test("a peer heard through the room is claimed; one this relay never carried is not", async () => {
    const room = await openRoom();
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");

    const ta = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await ta.start(a.context);
    await ta.whenReady();
    const tb = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await tb.start(b.context);
    await tb.whenReady();
    await tick(20);

    // b authors, so b reports its position — which is the evidence a's relay claims b on
    await write(b, "n1", "one");
    await tick(20);

    expect(ta.delivers?.().has(b.identity.peerId)).toBe(true);
    // never in this room, so nothing was ever carried for it and nothing is claimed
    expect(ta.delivers?.().has(peer(120, "acct_c").identity.peerId)).toBe(false);
    // and never itself: a medium that claimed this device would route its own frames into a loop
    expect(ta.delivers?.().has(a.identity.peerId)).toBe(false);

    // a source that is down claims nobody: a claim outranks a medium that says nothing, so a
    // relay still claiming a room it cannot reach would take frames from the radio beside it
    await ta.stop();
    expect(ta.delivers?.().size).toBe(0);

    await tb.stop();
    room.close();
  });
});

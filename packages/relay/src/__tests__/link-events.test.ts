import type { LinkEvent } from "@syncmesh/transport";

import { describe, expect, test } from "bun:test";

import type { RelayDial } from "../transport.js";

import { helloFrame } from "../frames.js";
import { relayTransport } from "../transport.js";
import { dialTo, openRoom, peer, tick } from "./fixtures.js";

/**
 * A relay builds its own `Transport` rather than going through `createFrameTransport`, so every
 * link-level fact it has is one this file has to prove it says out loud. The gap it closes was
 * visible: a device whose relay was not running showed a medium with an `unknown` condition, an
 * empty ending feed, and nothing anywhere naming the address it could not reach.
 */

const kinds = (seen: readonly LinkEvent[]) => seen.map((event) => event.kind);

describe("relayTransport link events", () => {
  test("a relay that is not running is an error naming the address, not silence", async () => {
    const a = peer(40, "acct_a");
    const seen: LinkEvent[] = [];
    const t = relayTransport({
      name: "ws:issues",
      dial: () => Promise.reject(new Error("could not reach ws://localhost:5236/issues")),
      reconnectMs: 5,
      forceReadyAfter: 10,
    });
    t.onLinkEvent?.((event) => void seen.push(event));
    // before the first dial nothing has failed, so the medium says so rather than drawing a red dot
    expect(t.condition?.()).toBe("unknown");
    await t.start(a.context);
    await t.whenReady();
    await tick(20);
    await t.stop();

    expect(kinds(seen)).toContain("error");
    expect(seen[0]?.transport).toBe("ws:issues");
    expect(seen[0]?.why).toBe("could not reach ws://localhost:5236/issues");
    expect(seen[0]?.at).toBeDefined();
    expect(t.condition?.()).toBe("connecting-failed");
  });

  test("a hello is a proof, and the hang-up after it is a close with a reason", async () => {
    const room = await openRoom();
    const a = peer(40, "acct_a");
    const seen: LinkEvent[] = [];
    const t = relayTransport({ dial: dialTo(room).dial, reconnectMs: 5 });
    t.onLinkEvent?.((event) => void seen.push(event));
    await t.start(a.context);
    await t.whenReady();
    await tick(20);
    expect(kinds(seen)).toContain("proven");
    expect(t.condition?.()).toBe("ok");
    // the relay names no peer id anywhere in its protocol, so the proof names none either
    expect(seen.find((event) => event.kind === "proven")?.peer).toBeUndefined();

    room.close();
    await tick(20);
    const closed = seen.find((event) => event.kind === "closed");
    expect(closed?.why).toBe("the relay socket closed");
    await t.stop();
  });

  test("a version the relay will not speak is a refusal, with the close that follows it", async () => {
    const room = await openRoom();
    const b = peer(80, "acct_b");
    const seen: LinkEvent[] = [];
    const t = relayTransport({ dial: dialTo(room).dial, versions: [99], reconnectMs: 5 });
    t.onLinkEvent?.((event) => void seen.push(event));
    await t.start(b.context);
    await tick(40);
    expect(kinds(seen)).toContain("refused");
    // separate answers to *why*: the door, and then the ending the door caused
    const closed = seen.find((event) => event.kind === "closed");
    expect(closed?.why).toBe("the relay speaks none of the protocol versions this build offers");
    expect(t.condition?.()).toBe("connecting-failed");
    await t.stop();
    room.close();
  });

  test("a relay that stops answering closes with the keepalive it missed", async () => {
    const a = peer(40, "acct_a");
    let mute = false;
    const seen: LinkEvent[] = [];
    const dial = (): RelayDial => {
      const frames = new Set<(f: Uint8Array) => void>();
      const closes = new Set<() => void>();
      return {
        send: () => {
          if (mute) return;
          mute = true;
          queueMicrotask(() => {
            const bytes = helloFrame(1, 10, "epoch-x", new Map());
            for (const cb of frames) cb(bytes);
          });
        },
        onFrame: (cb) => {
          frames.add(cb);
          return () => void frames.delete(cb);
        },
        onClose: (cb) => {
          closes.add(cb);
          return () => void closes.delete(cb);
        },
        close: () => {
          for (const cb of closes) cb();
        },
      };
    };
    const t = relayTransport({ dial, reconnectMs: 5 });
    t.onLinkEvent?.((event) => void seen.push(event));
    await t.start(a.context);
    await tick(60);
    await t.stop();
    const closed = seen.find((event) => event.kind === "closed");
    expect(closed?.why).toBe(
      "the relay stopped answering: no frame within 2.5 times its keepalive",
    );
  });

  test("bytes that never became a frame are dropped, and the link they arrived on stays up", async () => {
    const a = peer(40, "acct_a");
    const seen: LinkEvent[] = [];
    const frames = new Set<(f: Uint8Array) => void>();
    const dial = (): RelayDial => ({
      send: () =>
        queueMicrotask(() => {
          const bytes = helloFrame(1, 60_000, "epoch-x", new Map());
          for (const cb of frames) cb(bytes);
          for (const cb of frames) cb(Uint8Array.of(0xff, 0xff, 0xff));
        }),
      onFrame: (cb) => {
        frames.add(cb);
        return () => void frames.delete(cb);
      },
      onClose: () => () => undefined,
      close: () => undefined,
    });
    const t = relayTransport({ dial, reconnectMs: 5 });
    t.onLinkEvent?.((event) => void seen.push(event));
    await t.start(a.context);
    await tick(30);
    expect(kinds(seen)).toContain("dropped");
    // a dropped frame is below a link, so the socket carrying it is still the one that is `ok`
    expect(t.condition?.()).toBe("ok");
    await t.stop();
  });
});

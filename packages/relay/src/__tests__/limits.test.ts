import type { PeerId } from "@syncmesh/kernel";

import { createMemoryEventStore, tableDigests } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";
import { eventFrame } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import { webSocketDial } from "../dial.js";
import { blobGetFrame, joinFrame } from "../frames.js";
import { DEFAULT_LIMITS, createBudget } from "../limits.js";
import { startRelay } from "../serve.js";
import { relayTransport } from "../transport.js";
import { T0, bodyOf, fakeSocket, scriptedRoom, peer, tick, until, write } from "./fixtures.js";

const join = (peerId: PeerId) => joinFrame([1], peerId, new Map());
const SECOND = Temporal.Duration.from({ seconds: 1 });
/** Rate tables a test can exhaust in a line or two, rather than in four thousand frames. */
const tight = (event: number, blob: number) => ({
  rates: {
    event: { burst: event, every: SECOND },
    blob: { burst: blob, every: SECOND },
    // not under test here: a room of one client fans out to nobody
    fanout: DEFAULT_LIMITS.rates.fanout,
  },
});

describe("the frame-size cap", () => {
  test("a well-formed frame over the cap is refused before it is decoded, and the socket closed", async () => {
    const a = peer(40, "acct_a");
    const room = await scriptedRoom({ limits: { maxFrameBytes: 32 } });
    const s = fakeSocket();
    room.connect(s.socket).receive(join(a.identity.peerId)); // a valid join, comfortably over 32
    await tick();

    expect(s.ofKind("error")[0]?.code).toBe("frame-too-large"); // not "malformed": never decoded
    expect(s.closedWith).toEqual(["frame-too-large"]);
    expect(room.clients()).toBe(0); // and it never became a client
    room.close();
  });

  test("the same frame under the cap is served normally", async () => {
    const a = peer(40, "acct_a");
    const room = await scriptedRoom({ limits: { maxFrameBytes: DEFAULT_LIMITS.maxFrameBytes } });
    const s = fakeSocket();
    room.connect(s.socket).receive(join(a.identity.peerId));
    await tick();

    expect(s.ofKind("hello")).toHaveLength(1);
    expect(room.clients()).toBe(1);
    room.close();
  });
});

describe("per-socket token buckets", () => {
  test("event and blob are separate classes: spending one out leaves the other", async () => {
    const a = peer(40, "acct_a");
    const room = await scriptedRoom({ now: () => T0, limits: tight(1, 4) });
    const s = fakeSocket();
    const conn = room.connect(s.socket);
    conn.receive(join(a.identity.peerId)); // the join spends the only event token there was
    await tick();

    conn.receive(blobGetFrame("b3:0102")); // blobs have their own bucket, untouched
    await tick();
    expect(s.closedWith).toEqual([]);
    expect(s.ofKind("blob-missing")).toHaveLength(1);

    conn.receive(eventFrame(await write(a, "n1", "one"))); // and the event bucket is empty
    await tick();
    expect(s.ofKind("error")[0]?.code).toBe("rate");
    expect(s.closedWith).toEqual(["rate"]);
    expect(room.offset()).toBe(0); // the refused frame was never appended
    room.close();
  });

  test("over the rate the relay closes rather than buffers", async () => {
    const a = peer(40, "acct_a");
    const room = await scriptedRoom({ now: () => T0, limits: tight(2, 2) });
    const s = fakeSocket();
    const conn = room.connect(s.socket);
    conn.receive(join(a.identity.peerId));
    await tick();
    conn.receive(eventFrame(await write(a, "n1", "one")));
    await tick();
    expect(s.closedWith).toEqual([]); // two tokens, two frames

    conn.receive(eventFrame(await write(a, "n2", "two")));
    await tick();
    expect(s.closedWith).toEqual(["rate"]);
    expect(room.offset()).toBe(1); // nothing queued up waiting for a token
    room.close();
  });

  test("tokens come back with time, so a client at the declared rate is never hung up on", async () => {
    const a = peer(40, "acct_a");
    let at = T0;
    const room = await scriptedRoom({ now: () => at, limits: tight(1, 1) });
    const s = fakeSocket();
    const conn = room.connect(s.socket);
    conn.receive(join(a.identity.peerId)); // spends the one token
    await tick();

    at = T0.add({ seconds: 1 }); // one refill interval later
    conn.receive(eventFrame(await write(a, "n1", "one")));
    await tick();
    expect(s.closedWith).toEqual([]);
    expect(room.offset()).toBe(1);
    room.close();
  });

  test("a fractional refill is not lost: a steady drip at exactly the rate is admitted forever", () => {
    let at = T0;
    const budget = createBudget(
      { ...DEFAULT_LIMITS, maxFrameBytes: 1024, rates: tight(1, 1).rates },
      () => at,
    );
    expect(budget.take("event")).toBe(true);
    for (let i = 0; i < 20; i += 1) {
      at = at.add({ milliseconds: 500 });
      expect(budget.take("event")).toBe(i % 2 === 1); // half a token per step, spent every other
    }
  });
});

/**
 * The convergence question this repo keeps re-answering. A rate limit is not a verdict — no peer
 * folds it, and nothing about it reaches a row — so the only way it could diverge two honest
 * peers is by losing an event permanently. It cannot: the close is what the client's reconnect
 * is for, its fresh join re-requests from its own cursors, and the room's dedup makes the
 * re-push a no-op. This compares digests rather than rows, because comparing rows is what let
 * five earlier convergence bugs ship green.
 */
/** A rate table where the room's fan-out is what runs out, not its frames. */
const amplified = (fanout: number) => ({
  rates: {
    event: DEFAULT_LIMITS.rates.event,
    blob: DEFAULT_LIMITS.rates.blob,
    fanout: { burst: fanout, every: SECOND },
  },
});

describe("fan-out is metered too (gap audit №7)", () => {
  test("a socket pays for the sends its event caused, not for the one it made", async () => {
    const [a, b, c] = [peer(40, "acct_a"), peer(80, "acct_b"), peer(120, "acct_c")];
    // three deliveries' worth: the first event reaches two other clients, the second would not
    const room = await scriptedRoom({ now: () => T0, limits: amplified(3) });
    const sockets = [fakeSocket(), fakeSocket(), fakeSocket()];
    const conns = sockets.map((s) => room.connect(s.socket));
    conns[0]?.receive(join(a.identity.peerId));
    conns[1]?.receive(join(b.identity.peerId));
    conns[2]?.receive(join(c.identity.peerId));
    await tick();

    conns[0]?.receive(eventFrame(await write(a, "n1", "one")));
    await tick();
    expect(sockets[0]?.closedWith).toEqual([]); // two deliveries, one token left
    expect(room.offset()).toBe(1);

    // the second write is affordable as a frame and not as an amplification: two more deliveries
    // against one remaining token, and the *next* frame is what pays for it
    conns[0]?.receive(eventFrame(await write(a, "n2", "two")));
    await tick();
    expect(room.offset()).toBe(2);
    conns[0]?.receive(eventFrame(await write(a, "n3", "three")));
    await tick();

    expect(sockets[0]?.ofKind("error")[0]?.code).toBe("rate");
    expect(sockets[0]?.closedWith).toEqual(["rate"]);
    // and the clients it was amplifying to are untouched: one socket's debt is its own
    expect(sockets[1]?.closedWith).toEqual([]);
    expect(sockets[2]?.closedWith).toEqual([]);
    room.close();
  });

  test("a room of one costs nothing to write to, however tight the meter", async () => {
    const a = peer(40, "acct_a");
    const room = await scriptedRoom({ now: () => T0, limits: amplified(1) });
    const s = fakeSocket();
    const conn = room.connect(s.socket);
    conn.receive(join(a.identity.peerId));
    await tick();

    // an event nobody else is in the room for fans out to nobody, so it owes nothing
    for (const [id, body] of [
      ["n1", "one"],
      ["n2", "two"],
      ["n3", "three"],
    ] as const) {
      conn.receive(eventFrame(await write(a, id, body)));
      await tick();
    }
    expect(s.closedWith).toEqual([]);
    expect(room.offset()).toBe(3);
    room.close();
  });
});

describe("a rate-limited close loses nothing", () => {
  test("a client hung up on mid-push reconnects and both peers reach the same digest", async () => {
    const relay = await startRelay(0, {
      keepaliveMs: 60_000,
      store: createMemoryEventStore(),
      epoch: "epoch-1",
      limits: {
        rates: {
          // above the join preamble, below a twelve-event push: this costs several sockets
          event: { burst: 8, every: Temporal.Duration.from({ milliseconds: 20 }) },
          blob: DEFAULT_LIMITS.rates.blob,
          fanout: DEFAULT_LIMITS.rates.fanout,
        },
      },
    });
    try {
      const a = peer(40, "acct_a");
      const b = peer(80, "acct_b");
      for (let i = 1; i <= 12; i += 1) await write(a, `n${i}`, `body-${i}`);

      const ta = relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 });
      const tb = relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 });
      let hangUps = 0;
      ta.onStatus?.((up) => void (up ? undefined : (hangUps += 1)));
      await ta.start(a.context);
      await tb.start(b.context);

      const landed = await until(() => bodyOf(b, "n12") === "body-12", 15_000);
      expect(landed).toBe(true);
      expect(hangUps).toBeGreaterThan(0); // the push really did outrun the rate
      await tick(200);

      // digests, not rows: two peers that folded the same events must fingerprint identically
      expect([...tableDigests(b.engine.state())]).toEqual([...tableDigests(a.engine.state())]);
      await ta.stop();
      await tb.stop();
    } finally {
      await relay.stop();
    }
  }, 30_000);
});

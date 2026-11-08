import type { Cursors } from "@syncmesh/engine";
import type { EventId, PeerId, SeqNum } from "@syncmesh/kernel";
import type { Transport } from "@syncmesh/transport";

import { decodeAndVerify } from "@syncmesh/wire";
import { afterEach, describe, expect, test } from "bun:test";

import type { RelayRoom } from "../room.js";
import type { RelayDial } from "../transport.js";

import { MAX_ACKS_AHEAD, createDurability } from "../durability.js";
import { decodeRelayFrame } from "../frame-decode.js";
import { relayTransport } from "../transport.js";
import { dialTo, entryOf, openRoom, peer, tick, until, write } from "./fixtures.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const AUTHOR = "ab".repeat(32) as PeerId;
const id = (seq: number) => `${AUTHOR}-${seq}` as EventId;
const run = (seq: number): Cursors => new Map([[AUTHOR, seq as SeqNum]]);
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** Whether the promise has settled by now — after the microtasks and timers already queued. */
const settles = async (promise: Promise<unknown>, ms = 30): Promise<boolean> => {
  let done = false;
  void promise.then(() => (done = true));
  await tick(ms);
  return done;
};

describe("one link's record of what a durable room holds (D42)", () => {
  test("an ack past a hole is not a claim on the hole: newer acked first settles nothing older", async () => {
    const held = createDurability();
    held.hello("epoch-1", true, new Map());
    const first = held.durable(id(1));
    const third = held.durable(id(3));
    // a write made while the backlog is still being pushed reaches the room first
    held.acked(id(3));
    expect(await settles(first)).toBe(false);
    // the third itself is held, but only below an unbroken run does this link say so
    expect(await settles(third)).toBe(false);
    held.acked(id(1));
    expect(await settles(first)).toBe(true);
    expect(await settles(third)).toBe(false);
    held.acked(id(2));
    expect(await settles(third)).toBe(true);
  });

  test("the hello's run is held already: a write whose ack was lost settles on the next one", async () => {
    const held = createDurability();
    held.hello("epoch-1", true, new Map());
    const lost = held.durable(id(2));
    expect(await settles(lost)).toBe(false);
    held.hello("epoch-1", true, run(2));
    expect(await settles(lost)).toBe(true);
    // and anything at or below it answers at once
    expect(await settles(held.durable(id(1)), 0)).toBe(true);
  });

  test("a memory room's acks are dropped as they arrive; a durable hello later starts clean", async () => {
    const held = createDurability();
    held.hello("epoch-1", false, run(5));
    const waiting = held.durable(id(1));
    held.acked(id(1));
    expect(await settles(waiting)).toBe(false);
    held.hello("epoch-1", true, new Map());
    expect(await settles(waiting)).toBe(false);
    held.acked(id(1));
    expect((await waiting).isOk()).toBe(true);
  });

  test("a new epoch settles a waiter of the old one as DurabilityLost, not carried over", async () => {
    const held = createDurability();
    // a wait begun before any hello takes the first hello's lineage
    const early = held.durable(id(2));
    held.hello("epoch-1", true, new Map());
    const waiting = held.durable(id(1));
    expect(await settles(waiting)).toBe(false);
    held.hello("epoch-2", true, new Map());
    const answer = await waiting;
    expect(answer.isErr() && answer.error).toMatchObject({
      _tag: "DurabilityLost",
      event: id(1),
      expected: "epoch-1",
      actual: "epoch-2",
    });
    expect((await early).isErr()).toBe(true);
    // the same hello again is the same log: a wait begun under it waits on, and settles there
    const again = held.durable(id(1));
    held.hello("epoch-2", true, new Map());
    expect(await settles(again)).toBe(false);
    held.acked(id(1));
    expect((await again).isOk()).toBe(true);
  });

  test("a new epoch drops what the old lineage held, and a waiter begun after it settles on the new log's acks", async () => {
    const held = createDurability();
    held.hello("epoch-1", true, new Map());
    held.acked(id(1));
    held.acked(id(3));
    held.hello("epoch-2", true, new Map());
    // the old log's 1 is not the new log's: had it survived, this ack would close the run to 3
    held.acked(id(2));
    const third = held.durable(id(3));
    expect(await settles(third)).toBe(false);
    expect(await settles(held.durable(id(1)))).toBe(false);
    held.acked(id(1));
    held.acked(id(3));
    expect(await settles(third)).toBe(true);
  });

  test("acks past a hole are bounded; what is past the bound waits for the next hello", async () => {
    const held = createDurability();
    held.hello("epoch-1", true, new Map());
    // the hole is 1; everything from 2 is ahead of it
    for (let seq = 2; seq <= MAX_ACKS_AHEAD + 2; seq += 1) held.acked(id(seq));
    held.acked(id(1));
    expect(await settles(held.durable(id(MAX_ACKS_AHEAD + 1)), 0)).toBe(true);
    const past = held.durable(id(MAX_ACKS_AHEAD + 2));
    expect(await settles(past)).toBe(false);
    held.hello("epoch-1", true, run(MAX_ACKS_AHEAD + 2));
    expect(await settles(past)).toBe(true);
  });
});

const running: Transport[] = [];
afterEach(async () => {
  for (const t of running.splice(0)) await t.stop();
});

/** The capability every relay transport declares; a test that finds none has found a bug. */
const durableOf = (t: Transport) => {
  if (t.durable === undefined) throw new Error("a relay transport declares durable");
  return t.durable;
};

const eventId = (wire: Uint8Array) => entryOf(wire).event.id;
/* oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture */
const idFor = (p: ReturnType<typeof peer>, seq: number) => `${p.identity.peerId}-${seq}` as EventId;

/** What one dial of the scripted socket does: which acks reach the client, which events the room. */
interface Script {
  readonly dropAcks?: boolean;
  /** Events the client sends that never reach the room — a frame lost with its socket. */
  readonly lose?: (event: EventId) => boolean;
  /** Events held back until the test releases them: what a slow push looks like from the room. */
  readonly holdBack?: (event: EventId) => boolean;
}

/**
 * A dial onto a v2 room — no sealed link, so the frames both ways are readable — that does to each
 * session what `scripts` says, in dial order; dials past the last script are untouched.
 */
const scripted = (room: RelayRoom, scripts: readonly Script[]) => {
  const inner = dialTo(room);
  const held: Array<() => void> = [];
  const acks: string[] = [];
  let dials = 0;
  let live: RelayDial | undefined;
  const dial = (): RelayDial => {
    const script = scripts[dials] ?? {};
    dials += 1;
    const dialed = inner.dial();
    live = dialed;
    const event = (frame: Uint8Array): EventId | undefined => {
      const decoded = decodeRelayFrame(frame);
      if (decoded.isErr() || decoded.value.kind !== "session") return undefined;
      const session = decoded.value.frame;
      return session.kind === "event" ? decodeAndVerify(session.wire).unwrap().event.id : undefined;
    };
    return {
      send: (frame) => {
        const sent = event(frame);
        if (sent !== undefined && script.lose?.(sent) === true) return;
        if (sent !== undefined && script.holdBack?.(sent) === true) {
          held.push(() => dialed.send(frame));
          return;
        }
        dialed.send(frame);
      },
      onFrame: (cb) =>
        dialed.onFrame((frame) => {
          const decoded = decodeRelayFrame(frame);
          if (decoded.isOk() && decoded.value.kind === "ack") {
            acks.push(decoded.value.id);
            if (script.dropAcks === true) return;
          }
          cb(frame);
        }),
      onClose: dialed.onClose,
      close: dialed.close,
    };
  };
  return {
    dial,
    dials: () => dials,
    /** Every ack the room sent, delivered or not. */
    acks,
    release: () => {
      for (const send of held.splice(0)) send();
    },
    hangUp: () => live?.close(),
  };
};

const attach = async (p: ReturnType<typeof peer>, dial: () => RelayDial) => {
  const transport = relayTransport({ dial, versions: [2], reconnectMs: 10, maxReconnectMs: 20 });
  running.push(transport);
  await transport.start(p.context);
  await transport.caughtUp?.();
  return transport;
};

describe("durable over a relay (D42)", () => {
  test("the relay transport declares durable beside blobs and visibility", () => {
    const transport = relayTransport({ dial: () => Promise.reject(new Error("never dialled")) });
    expect(transport.durable).toBeDefined();
  });

  test("a durable room's ack settles the write; a memory room's never does", async () => {
    const durable = await openRoom({ durable: true, versions: [2] });
    const memory = await openRoom({ versions: [2] });
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const ta = await attach(a, dialTo(durable).dial);
    const tb = await attach(b, dialTo(memory).dial);

    const kept = durableOf(ta)(eventId(await write(a, "n1", "kept")));
    const lost = durableOf(tb)(eventId(await write(b, "n2", "lost on restart")));
    expect(await settles(kept, 100)).toBe(true);
    // the memory room took it and acked it: the ack is real, the durability is not
    expect(await until(() => memory.offset() === 1)).toBe(true);
    expect(await settles(lost, 100)).toBe(false);
    // and nothing about it reached the acknowledgement map: the relay is not a peer
    expect([...a.engine.acks().keys()]).toEqual([]);
    durable.close();
    memory.close();
  });

  test("a newer write acked before an older one is pushed settles neither until the older lands", async () => {
    const room = await openRoom({ durable: true, versions: [2] });
    const a = peer(40, "acct_a");
    // the first write a's log numbers; held back the way a queued push leaves it behind a live write
    const older = idFor(a, 1);
    const wire = scripted(room, [{ holdBack: (event) => event === older }]);
    const ta = await attach(a, wire.dial);

    expect(eventId(await write(a, "n1", "older"))).toBe(older);
    const newer = eventId(await write(a, "n2", "newer"));
    expect(await until(() => wire.acks.includes(newer))).toBe(true);
    // the room holds the newer one and not the older: a newest-ack cursor would claim both
    expect(await settles(durableOf(ta)(older))).toBe(false);
    expect(await settles(durableOf(ta)(newer))).toBe(false);

    wire.release();
    expect(await settles(durableOf(ta)(older), 100)).toBe(true);
    expect(await settles(durableOf(ta)(newer), 100)).toBe(true);
    room.close();
  });

  test("an ack lost with its socket: the next session's hello says the room holds it", async () => {
    const room = await openRoom({ durable: true, versions: [2] });
    const a = peer(40, "acct_a");
    const wire = scripted(room, [{ dropAcks: true }]);
    const ta = await attach(a, wire.dial);

    const stored = eventId(await write(a, "n1", "stored, never acked"));
    expect(await until(() => wire.acks.includes(stored))).toBe(true);
    const waiting = durableOf(ta)(stored);
    expect(await settles(waiting)).toBe(false);

    wire.hangUp();
    expect(await settles(waiting, 200)).toBe(true);
    expect(wire.dials()).toBe(2);
    // settled by the hello alone: the push after it had nothing to resend, so nothing was acked again
    expect(wire.acks).toEqual([stored]);
    room.close();
  });

  test("an ack lost past a hole: the resend is a duplicate, and the duplicate's ack settles it", async () => {
    const room = await openRoom({ durable: true, versions: [2] });
    const a = peer(40, "acct_a");
    const first = idFor(a, 1);
    // the first session loses the first write on the way and every ack on the way back, so the
    // room holds the second past a hole — which its next hello cannot vouch for
    const wire = scripted(room, [{ dropAcks: true, lose: (event) => event === first }]);
    const ta = await attach(a, wire.dial);

    expect(eventId(await write(a, "n1", "lost on the way"))).toBe(first);
    const second = eventId(await write(a, "n2", "stored, ack lost"));
    expect(await until(() => wire.acks.includes(second))).toBe(true);
    expect(room.offset()).toBe(1);
    const waiting = durableOf(ta)(second);

    wire.hangUp();
    expect(await settles(waiting, 200)).toBe(true);
    // the room appended the first and only acked the second again: a duplicate is acked too
    expect(wire.acks.filter((acked) => acked === second)).toHaveLength(2);
    expect(room.offset()).toBe(2);
    room.close();
  });
});

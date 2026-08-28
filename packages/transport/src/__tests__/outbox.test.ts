import { describe, expect, test } from "bun:test";

import type { FrameClass } from "../frame-parts.js";
import type { FrameLink } from "../link.js";

import { bridgeFramedLink } from "../bridge.js";
import { KIND } from "../frame-parts.js";
import { decodeFrame } from "../frame.js";
import { createOutbox } from "../outbox.js";
import { T0, peer, write } from "./fixtures.js";

/** A drain the test decides the moment of, so the ordering is asserted rather than raced. */
const held = () => {
  let pending: (() => void) | undefined;
  return {
    schedule: (drain: () => void) => void (pending = drain),
    turn: () => {
      const drain = pending;
      pending = undefined;
      drain?.();
    },
  };
};

const bytes = (n: number) => Uint8Array.of(n);

describe("the outbox orders one session's sending", () => {
  test("frames leave in tag order, whatever order they were written in", () => {
    const sent: string[] = [];
    const clock = held();
    const outbox = createOutbox((_cls, what) => void sent.push(what), clock.schedule);

    outbox.send(KIND.snapshot, "snap-chunk", bytes(1));
    outbox.send(KIND.event, "event", bytes(2));
    outbox.send(KIND.cursors, "cursors", bytes(3));
    outbox.send(KIND.grant, "grant", bytes(4));
    expect(sent).toEqual([]);

    clock.turn();
    expect(sent).toEqual(["grant", "cursors", "event", "snap-chunk"]);
  });

  test("within a class it is first in, first out — the gap rule and the join both need it", () => {
    const sent: number[] = [];
    const clock = held();
    const outbox = createOutbox(
      (_cls, _what, frame) => void sent.push(frame[0] ?? -1),
      clock.schedule,
    );

    for (const seq of [1, 2, 3, 4]) outbox.send(KIND.event, "event", bytes(seq));
    outbox.send(KIND.snapshot, "snap-manifest", bytes(10));
    for (const page of [11, 12]) outbox.send(KIND.snapshot, "snap-chunk", bytes(page));
    clock.turn();
    expect(sent).toEqual([1, 2, 3, 4, 10, 11, 12]);
  });

  test("nothing offered is lost: a grant queued mid-drain still goes before the events", () => {
    const sent: string[] = [];
    const clock = held();
    const outbox = createOutbox((_cls, what) => {
      sent.push(what);
      // a registered grant propagating from inside a send — the re-entrant case
      if (what === "cursors") outbox.send(KIND.grant, "grant", bytes(9));
    }, clock.schedule);

    outbox.send(KIND.cursors, "cursors", bytes(1));
    outbox.send(KIND.event, "event", bytes(2));
    clock.turn();
    expect(sent).toEqual(["cursors", "grant", "event"]);
  });

  test("presence yields to the events and is still all delivered — two topics are not one value", () => {
    const sent: number[] = [];
    const clock = held();
    const outbox = createOutbox(
      (_cls, _what, frame) => void sent.push(frame[0] ?? -1),
      clock.schedule,
    );

    // two topics, not two versions of one: conflating them here would lose a live value, because
    // nothing in these bytes says which topic they belong to. That job is the presence store's.
    outbox.send(KIND.presence, "presence", bytes(1));
    outbox.send(KIND.presence, "presence", bytes(2));
    outbox.send(KIND.event, "event", bytes(3));
    clock.turn();
    expect(sent).toEqual([3, 1, 2]);
  });

  test("drain is idempotent, and an empty outbox drains to nothing", () => {
    const sent: string[] = [];
    const clock = held();
    const outbox = createOutbox((_cls, what) => void sent.push(what), clock.schedule);
    outbox.drain();
    outbox.send(KIND.event, "event", bytes(1));
    outbox.drain();
    outbox.drain();
    clock.turn();
    expect(sent).toEqual(["event"]);
  });
});

/** Records what actually left, in order, decoded back to the tags the far side would see. */
const recorder = () => {
  const frames: Uint8Array[] = [];
  const link: FrameLink = {
    send: (frame) => void frames.push(frame),
    onFrame: () => () => undefined,
  };
  return {
    link,
    kinds: () => frames.map((f) => decodeFrame(f).unwrap().kind),
  };
};

describe("the bridge sends by class", () => {
  test("a session opens with its grants, then its cursors, and the events come after both", async () => {
    const alice = peer(40, "acct_a");
    const tap = recorder();
    const bridge = bridgeFramedLink(tap.link, {
      engine: alice.engine,
      identity: alice.identity,
      grants: alice.grants,
      now: () => T0,
    });
    (await write(alice, "n1", "one")).unwrap();
    await bridge.flush();

    const kinds = tap.kinds();
    expect(kinds[0]).toBe("grant");
    expect(kinds.indexOf("grant")).toBeLessThan(kinds.indexOf("cursors"));
    expect(kinds.indexOf("cursors")).toBeLessThan(kinds.indexOf("event"));
    expect(kinds.filter((k) => k === "event")).toHaveLength(1);
  });

  test("four classes offered in one turn leave in tag order, none of them dropped", async () => {
    const alice = peer(40, "acct_a");
    const tap = recorder();
    const bridge = bridgeFramedLink(tap.link, {
      engine: alice.engine,
      identity: alice.identity,
      grants: alice.grants,
      now: () => T0,
    });
    await bridge.flush();
    const opened = tap.kinds().length;

    // written worst-first on purpose: the bulk request, then the ephemeral, then the one frame
    // an ungranted device cannot proceed without
    bridge.requestSnapshot();
    bridge.sendPresence(Uint8Array.of(7));
    bridge.requestGrant("inv");
    await bridge.flush();

    expect(tap.kinds().slice(opened)).toEqual(["grant-request", "presence", "snap-req"]);
  });

  test("a frame the link refuses is still reported loudly, once the outbox has run", async () => {
    const alice = peer(40, "acct_a");
    const errors: string[] = [];
    let offered = 0;
    const dead: FrameLink = {
      send: () => {
        offered += 1;
        throw new Error("the frame did not leave");
      },
      onFrame: () => () => undefined,
    };
    const bridge = bridgeFramedLink(dead, {
      engine: alice.engine,
      identity: alice.identity,
      grants: alice.grants,
      now: () => T0,
    });
    bridge.onError((e) => void errors.push(e._tag));
    bridge.sendGrant(new Uint8Array());
    // presence is the one class whose loss is not an error: the next value replaces it
    bridge.sendPresence(Uint8Array.of(1));
    await bridge.flush();

    expect(offered).toBeGreaterThan(1);
    expect(errors).toEqual(Array.from({ length: offered - 1 }, () => "SendFailed"));
  });
});

/** The classes are the wire tags; if this ever needs a second enum, the design has drifted. */
test("the class tag is the frame tag", () => {
  const classes: readonly FrameClass[] = [KIND.grant, KIND.cursors, KIND.event, KIND.snapshot];
  expect([...classes].sort((x, y) => x - y)).toEqual([...classes]);
});

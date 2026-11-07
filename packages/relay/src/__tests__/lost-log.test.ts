import type { LinkEvent } from "@syncmesh/transport";

import { describe, expect, test } from "bun:test";

import { relayTransport } from "../transport.js";
import { bodyOf, dialTo, openRoom, peer, tick, until, write } from "./fixtures.js";

/**
 * A key that outlives its log (RFC 0024 G7): the store is lost, the identity is not — a key kept
 * in a keychain, a file beside the database, or an authority redeployed over an empty volume. A
 * device numbers its writes from its own log, and a room drops an `(author, seq)` it already
 * holds as a duplicate, so without a guard every write after the rejoin vanishes and nothing says
 * so.
 */
describe("a device that lost its log under a key that did not", () => {
  test("gets its own writes back and numbers the next one after what the room holds", async () => {
    const room = await openRoom();
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const ta = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    const tb = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await ta.start(a.context);
    await tb.start(b.context);
    await ta.whenReady();
    await tb.whenReady();
    await write(a, "n1", "one");
    await write(a, "n2", "two");
    await write(a, "n3", "three");
    expect(await until(() => bodyOf(b, "n3") === "three")).toBe(true);
    await ta.stop();

    // same seed, fresh memory store: the log is gone, the key is not
    const reborn = peer(40, "acct_a");
    const seen: LinkEvent[] = [];
    const tr = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    tr.onLinkEvent?.((event) => void seen.push(event));
    await tr.start(reborn.context);
    await tr.whenReady();
    await tick(20);
    // its own history is its own again
    expect(bodyOf(reborn, "n1")).toBe("one");
    expect(Number(reborn.engine.coverage().synced.get(reborn.identity.peerId))).toBe(3);
    // and a fresh log that wrote nothing lost nothing, so there is nothing to say
    expect(seen.some((e) => e.kind === "dropped")).toBe(false);

    await write(reborn, "n4", "four");
    expect(Number((await reborn.engine.eventsSince(new Map())).unwrap().at(-1)?.event.seqNum)).toBe(
      4,
    );
    expect(await until(() => bodyOf(b, "n4") === "four")).toBe(true);

    await tr.stop();
    await tb.stop();
    room.close();
  });

  test("a write the lost log made before rejoining is said, and what follows is numbered past the room", async () => {
    const room = await openRoom();
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const ta = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    const tb = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await ta.start(a.context);
    await tb.start(b.context);
    await ta.whenReady();
    await tb.whenReady();
    await write(a, "n1", "one");
    await write(a, "n2", "two");
    expect(await until(() => bodyOf(b, "n2") === "two")).toBe(true);
    await ta.stop();

    const reborn = peer(40, "acct_a");
    await write(reborn, "x1", "offline"); // seq 1, a number the room holds for another event
    const seen: LinkEvent[] = [];
    const tr = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    tr.onLinkEvent?.((event) => void seen.push(event));
    await tr.start(reborn.context);
    await tr.whenReady();
    await tick(20);
    expect(
      seen.some(
        (e) => e.kind === "dropped" && String(e.why).includes("holds writes by this device"),
      ),
    ).toBe(true);

    await write(reborn, "n3", "three");
    expect(await until(() => bodyOf(b, "n3") === "three")).toBe(true);

    await tr.stop();
    await tb.stop();
    room.close();
  });
});

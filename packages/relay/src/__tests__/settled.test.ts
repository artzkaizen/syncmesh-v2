import { describe, expect, test } from "bun:test";

import { relayTransport } from "../transport.js";
import { bodyOf, dialTo, openRoom, peer, write } from "./fixtures.js";

/**
 * `caughtUp` is the answer an app draws an empty state on, and for a relay it used to be the
 * answer to a different question.
 *
 * It raced the last catch-up page against `whenReady`, and `whenReady` resolves the moment the
 * relay says hello — so `mesh.settled()` meant "the socket opened". A second install of
 * `apps/issues` joining a seeded room read its own empty database, concluded the workspace needed
 * seeding and authored a duplicate of it. That converged, because the seed is deterministic, and
 * left a room with two authors for every row in it.
 */
describe("relayTransport caughtUp", () => {
  test("does not answer on the hello: the room's events are held by the time it does", async () => {
    const room = await openRoom();
    const author = peer(40, "acct_a");
    const joiner = peer(80, "acct_b");
    const first = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await first.start(author.context);
    await first.whenReady();
    await write(author, "n1", "one");
    await write(author, "n2", "two");
    await write(author, "n3", "three");
    await Bun.sleep(30);
    expect(room.offset()).toBe(3);

    const second = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    await second.start(joiner.context);
    await second.whenReady();
    await second.caughtUp?.();
    // the question the seed gate asks, asked at the only moment it is allowed to be wrong
    expect(bodyOf(joiner, "n3")).toBe("three");

    await first.stop();
    await second.stop();
    room.close();
  });

  test("a relay that never speaks still answers, at the force-ready deadline", async () => {
    const alone = peer(40, "acct_a");
    const t = relayTransport({
      dial: () => Promise.reject(new Error("could not reach ws://localhost:1/none")),
      reconnectMs: 5,
      forceReadyAfter: 30,
    });
    await t.start(alone.context);
    const began = Date.now();
    await t.caughtUp?.();
    // bounded, because a source that cannot answer must never be the one that wedges the mesh
    expect(Date.now() - began).toBeLessThan(1000);
    await t.stop();
  });
});

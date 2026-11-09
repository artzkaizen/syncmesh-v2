import { parseSchemaVersion, parseSeqNum } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { createRejoins } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import { relayTransport } from "../transport.js";
import { T0, dialTo, entryOf, mintFor, openRoom, peer, tick, until, write } from "./fixtures.js";

describe("a relay session's cursors frame (D31)", () => {
  test("carries the schema this build declares, and the other end's fleet reading takes it", async () => {
    const room = await openRoom();
    const alice = peer(40, "acct_a", 100, { schemaVersion: parseSchemaVersion(3).unwrap() });
    const bob = peer(80, "acct_b", 500, { schemaVersion: parseSchemaVersion(5).unwrap() });
    const links = [alice, bob].map((device) => {
      const link = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
      return { device, link };
    });
    for (const { device, link } of links) {
      await link.start(device.context);
      await link.whenReady();
    }
    await tick(20);

    // bob writes nothing, so the version alice reads for him comes from his cursors frames:
    // the one after his catch-up, and the one he answers her write with. The room's word on
    // him at his join carries none.
    await write(alice, "n1", "one");
    const announced = () => alice.engine.acksAt().get(bob.identity.peerId)?.schemaVersion;
    await until(() => announced() !== undefined, 1000);
    expect<number | undefined>(alice.engine.oldestSchema().get(bob.identity.peerId)?.version).toBe(
      5,
    );
    expect<number | undefined>(announced()).toBe(5);

    for (const { link } of links) await link.stop();
    room.close();
  });

  test("is sent once a join has caught up, so a peer that never folds anything is still heard", async () => {
    const room = await openRoom();
    const alice = peer(40, "acct_a", 100, { schemaVersion: parseSchemaVersion(3).unwrap() });
    const bob = peer(80, "acct_b", 500, { schemaVersion: parseSchemaVersion(5).unwrap() });
    const links = [alice, bob].map((device) => {
      const link = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
      return { device, link };
    });
    for (const { device, link } of links) {
      await link.start(device.context);
      await link.whenReady();
    }

    // nobody writes: the room's join frame for bob carries no version, so only the cursors
    // frame bob sends after his catch-up can tell alice which build he runs
    const announced = () => alice.engine.acksAt().get(bob.identity.peerId)?.schemaVersion;
    await until(() => announced() !== undefined, 1000);
    expect<number | undefined>(announced()).toBe(5);

    for (const { link } of links) await link.stop();
    room.close();
  });
});

/**
 * A device that reaches a peer only through the room, below that peer's compaction floor, was
 * never told: the floor rides a peer's cursors frame (D46), but a relay session sent its own
 * without one and read none on the frames the room passed on, and the room serves no state. It
 * held a run it could never complete with no `$recovery` issue (chaos soak, `--retention`, seeds
 * 1 and 9 at six devices).
 */
describe("a peer's floor the room passes on (gaps U52)", () => {
  test("reaches a device below it as a relayed issue, which goes once it catches up", async () => {
    const room = await openRoom();
    const author = peer(120, "acct_c");
    const alice = peer(40, "acct_a", 100, { compacts: true });
    const bob = peer(80, "acct_b");
    const wires = [await write(author, "n1", "one"), await write(author, "n2", "two")];
    for (const device of [alice, bob])
      device.grants.register(mintFor(author.identity, "acct_c")).unwrap();
    // alice took the author's run, a neighbour said it holds it too, and alice compacted it away
    // before she ever reached the room
    (await alice.engine.receiveBatch(wires.map(entryOf))).unwrap();
    const later = T0.add(Temporal.Duration.from({ hours: 1 }));
    const run = new Map([[author.identity.peerId, parseSeqNum(wires.length).unwrap()]]);
    alice.engine.acknowledge(peer(160, "acct_d").identity.peerId, run, later);
    const forgetPeersAfter = Temporal.Duration.from({ minutes: 1 });
    (await alice.engine.compact({ now: later, forgetPeersAfter })).unwrap();
    expect(alice.engine.floor()).toEqual(run);

    const rejoins = createRejoins();
    const links = [
      { device: bob, link: relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 }) },
      { device: alice, link: relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 }) },
    ];
    for (const { device, link } of links) {
      await link.start(device === bob ? { ...device.context, rejoins } : device.context);
      await link.whenReady();
    }

    expect(await until(() => rejoins.issues().length === 1, 2000)).toBe(true);
    expect(rejoins.issues()).toMatchObject([
      {
        peer: alice.identity.peerId,
        reason: "relayed",
        floor: run,
      },
    ]);

    // the run from somewhere that folds: the issue goes with it
    (await bob.engine.receiveBatch(wires.map(entryOf))).unwrap();
    expect(rejoins.issues()).toEqual([]);

    for (const { link } of links) await link.stop();
    room.close();
  });
});

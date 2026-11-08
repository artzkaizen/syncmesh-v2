import { parseSchemaVersion } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { relayTransport } from "../transport.js";
import { dialTo, openRoom, peer, tick, until, write } from "./fixtures.js";

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

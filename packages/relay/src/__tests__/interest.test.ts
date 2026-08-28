import type { PeerId, TableName } from "@syncmesh/kernel";

import { type Interest } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { gt } from "@syncmesh/policy";
import { eventFrame } from "@syncmesh/transport";
import { decodeAndVerify, encodeCbor, hexToBytes, signEvent } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { joinFrame } from "../frames.js";
import { fakeSocket, openRoom, peer, tick, write } from "./fixtures.js";

const GLOBEX = parsePartitionKey("org:globex").unwrap();
/* oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- a table name this schema does not define, so an interest naming it wants nothing the room holds */
const NOTES_ELSEWHERE = "somewhere_else" as TableName;

const open = () => openRoom({ pageSize: 100 });

const join = (peerId: PeerId, interest?: Interest) => joinFrame([1], peerId, new Map(), interest);

describe("interest at the relay", () => {
  test("a joiner is caught up with what it asked for, and nothing else", async () => {
    const a = peer(40, "acct_a");
    const room = await open();
    const author = fakeSocket();
    const ca = room.connect(author.socket);
    ca.receive(join(a.identity.peerId));
    await tick();

    // three events: two in acme, one in globex
    for (const wire of [
      await write(a, "n1", "one"),
      await write(a, "n2", "two"),
      await write(a, "g1", "other", GLOBEX),
    ]) {
      ca.receive(eventFrame(wire));
    }
    await tick();
    expect(room.offset()).toBe(3);

    const wide = fakeSocket();
    room.connect(wide.socket).receive(join(peer(80, "acct_b").identity.peerId));
    await tick();
    expect(wide.events()).toBe(3);

    const narrow = fakeSocket();
    room
      .connect(narrow.socket)
      .receive(join(peer(120, "acct_c").identity.peerId, { partitions: [GLOBEX] }));
    await tick();
    expect(narrow.events()).toBe(1); // one board out of two
    room.close();
  });

  test("an event about no instance reaches a device that named instances (D24)", async () => {
    const a = peer(40, "acct_a");
    const room = await open();
    const author = fakeSocket();
    const ca = room.connect(author.socket);
    ca.receive(join(a.identity.peerId));
    await tick();

    // a catalog write: authored by the authority, in no instance, and meant for every device.
    // Excluding it from an interest that names instances made it reach every device except the
    // ones careful enough to narrow — which is the whole population it exists for
    const pinned = decodeAndVerify(await write(a, "c1", "catalog", GLOBEX)).unwrap().event;
    const { partition: _dropped, ...unpinned } = pinned;
    ca.receive(eventFrame(signEvent(unpinned, a.identity).wire));
    await tick();
    expect(room.offset()).toBe(1);

    const narrow = fakeSocket();
    room
      .connect(narrow.socket)
      .receive(join(peer(120, "acct_c").identity.peerId, { partitions: [GLOBEX] }));
    await tick();
    expect(narrow.events()).toBe(1);

    // and a device that genuinely does not want it says so on the dimension that can say it
    const byTable = fakeSocket();
    room
      .connect(byTable.socket)
      .receive(join(peer(160, "acct_d").identity.peerId, { tables: [NOTES_ELSEWHERE] }));
    await tick();
    expect(byTable.events()).toBe(0);
    room.close();
  });

  test("live fan-out obeys the same interest, and one client's does not affect another's", async () => {
    const a = peer(40, "acct_a");
    const room = await open();
    const ca = room.connect(fakeSocket().socket);
    ca.receive(join(a.identity.peerId));

    const wide = fakeSocket();
    room.connect(wide.socket).receive(join(peer(80, "acct_b").identity.peerId));
    const narrow = fakeSocket();
    room
      .connect(narrow.socket)
      .receive(join(peer(120, "acct_c").identity.peerId, { partitions: [GLOBEX] }));
    await tick();
    wide.sent.length = 0;
    narrow.sent.length = 0;

    ca.receive(eventFrame(await write(a, "n1", "acme")));
    await tick();
    expect(wide.events()).toBe(1);
    expect(narrow.events()).toBe(0); // not this board

    ca.receive(eventFrame(await write(a, "g1", "globex", GLOBEX)));
    await tick();
    expect(wide.events()).toBe(2);
    expect(narrow.events()).toBe(1); // and this one is
    room.close();
  });

  test("an interest narrows and never widens: it cannot reach a partition the sender would not send", async () => {
    const a = peer(40, "acct_a");
    const room = await open();
    const ca = room.connect(fakeSocket().socket);
    ca.receive(join(a.identity.peerId));
    ca.receive(eventFrame(await write(a, "n1", "acme")));
    await tick();

    // asking for two boards when the log holds one gets one, not an error and not more —
    // an interest is a request about what to send, never a claim about what may be seen
    const asker = fakeSocket();
    room
      .connect(asker.socket)
      .receive(join(peer(80, "acct_b").identity.peerId, { partitions: [GLOBEX] }));
    await tick();
    expect(asker.events()).toBe(0);
    room.close();
  });

  test("an unreadable interest serves everything rather than starving the device", async () => {
    const a = peer(40, "acct_a");
    const room = await open();
    const ca = room.connect(fakeSocket().socket);
    ca.receive(join(a.identity.peerId));
    ca.receive(eventFrame(await write(a, "n1", "one")));
    await tick();

    // a join whose interest position is junk: the relay falls back to everything the policy
    // allows, because silently sending nothing looks like a working relay with an empty room
    const b = peer(80, "acct_b");
    const junk = encodeCbor([8, [1], hexToBytes(b.identity.peerId).unwrap(), [], "{not json"]);
    const socket = fakeSocket();
    room.connect(socket.socket).receive(junk);
    await tick();
    expect(socket.events()).toBe(1);
    room.close();
  });

  test("a predicate interest reaches the wire and filters by row", async () => {
    const a = peer(40, "acct_a");
    const room = await open();
    const ca = room.connect(fakeSocket().socket);
    ca.receive(join(a.identity.peerId));
    ca.receive(eventFrame(await write(a, "n1", "one")));
    await tick();

    // `body` is the fixture's only column; a predicate that no row satisfies filters everything
    const picky = fakeSocket();
    room
      .connect(picky.socket)
      .receive(join(peer(80, "acct_b").identity.peerId, { where: gt("body", "zzz") }));
    await tick();
    expect(picky.events()).toBe(0);

    const generous = fakeSocket();
    room
      .connect(generous.socket)
      .receive(join(peer(120, "acct_c").identity.peerId, { where: gt("body", "a") }));
    await tick();
    expect(generous.events()).toBe(1);
    room.close();
  });
});

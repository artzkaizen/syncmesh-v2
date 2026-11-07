import type { PeerId } from "@syncmesh/kernel";

import { type Interest } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { eventFrame } from "@syncmesh/transport";
import { encodeCbor, hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { joinFrame } from "../frames.js";
import { fakeSocket, scriptedRoom, peer, tick, write } from "./fixtures.js";

const GLOBEX = parsePartitionKey("org:globex").unwrap();

const open = () => scriptedRoom({ pageSize: 100 });

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

  test("a burst a narrowed client does not want costs it one pass-over, not one frame per event", async () => {
    const a = peer(40, "acct_a");
    const room = await open();
    const ca = room.connect(fakeSocket().socket);
    ca.receive(join(a.identity.peerId));
    const narrow = Array.from({ length: 5 }, () => fakeSocket());
    for (const [i, s] of narrow.entries())
      room
        .connect(s.socket)
        .receive(join(peer(80 + i * 40, `acct_${i}`).identity.peerId, { partitions: [GLOBEX] }));
    await tick();
    for (const s of narrow) s.sent.length = 0;

    // ten events none of them asked for, arriving together
    const wires: Uint8Array[] = [];
    for (let i = 0; i < 10; i += 1) wires.push(await write(a, `n${i}`, "acme"));
    for (const wire of wires) ca.receive(eventFrame(wire));
    await tick(50);
    expect(room.offset()).toBe(10);
    const run = a.engine.coverage().synced.get(a.identity.peerId);
    for (const s of narrow) {
      expect(s.events()).toBe(0);
      // one empty last page, claiming the whole run it passed over
      const pages = s.ofKind("page");
      expect(pages).toHaveLength(1);
      expect(pages[0]?.scoped?.synced.get(a.identity.peerId)).toBe(run);
    }

    // a wanted event after it: the event, and nothing owed to say about it
    for (const s of narrow) s.sent.length = 0;
    ca.receive(eventFrame(await write(a, "g1", "globex", GLOBEX)));
    await tick();
    for (const s of narrow) expect(s.frames().map((f) => f.kind)).toEqual(["relayed"]);
    room.close();
  });

  test("a wanted event behind withheld ones carries the pass-over straight after it", async () => {
    const a = peer(40, "acct_a");
    const room = await open();
    const ca = room.connect(fakeSocket().socket);
    ca.receive(join(a.identity.peerId));
    const narrow = fakeSocket();
    room
      .connect(narrow.socket)
      .receive(join(peer(80, "acct_b").identity.peerId, { partitions: [GLOBEX] }));
    await tick();
    narrow.sent.length = 0;

    // withheld, then wanted, in one burst: the queued pass-over has not run when the wanted one lands
    const withheldWire = await write(a, "n1", "acme");
    const wantedWire = await write(a, "g1", "globex", GLOBEX);
    ca.receive(eventFrame(withheldWire));
    ca.receive(eventFrame(wantedWire));
    await tick();
    const kinds = narrow.frames().map((f) => f.kind);
    expect(kinds).toEqual(["relayed", "page"]);
    // claimed through the wanted event, which went out first
    expect(narrow.ofKind("page")[0]?.scoped?.synced.get(a.identity.peerId)).toBe(
      a.engine.coverage().synced.get(a.identity.peerId),
    );
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
});

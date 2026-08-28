import type { Change } from "@syncmesh/kernel";

import { eventFrame } from "@syncmesh/transport";
import { decodeAndVerify, signEvent } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { joinFrame } from "../frames.js";
import { fakeSocket, openRoom, peer, tick, write } from "./fixtures.js";

/**
 * The same row, written under a tag this build has no fold for. Tag 3 is `increment`, reserved
 * for a cell kind no encoder here emits — a newer build's change, in the shape it really arrives.
 */
const opaque = (at: { readonly table: Change["table"]; readonly key: Change["key"] }): Change => ({
  kind: "unknown",
  tag: 3,
  table: at.table,
  key: at.key,
  data: new Map<string, number>([["count", 7]]),
});

describe("an event a relay cannot read", () => {
  test("is stored and re-served, rather than refused at the door", async () => {
    const author = peer(40, "acct_a");
    const room = await openRoom({ pageSize: 100 });
    const writer = fakeSocket();
    const conn = room.connect(writer.socket);
    conn.receive(joinFrame([1], author.identity.peerId, new Map()));
    await tick();

    // a newer build's write, in the shape it will really arrive in: through the codec, signed,
    // carrying a tag this build has no fold for
    const plain = decodeAndVerify(await write(author, "n1", "one")).unwrap().event;
    const at = plain.changes[0];
    if (at === undefined) throw new Error("the write produced no change to stand in for");
    const forged = signEvent({ ...plain, changes: [opaque(at)] }, author.identity).wire;
    conn.receive(eventFrame(forged));
    await tick();

    // refusing it here is what used to drop it before any device could park it: the relay would
    // have read a wire error and thrown the event away, and no later build could ever ask again
    expect(room.offset()).toBe(1);

    const joiner = fakeSocket();
    room
      .connect(joiner.socket)
      .receive(joinFrame([1], peer(80, "acct_b").identity.peerId, new Map()));
    await tick();
    expect(joiner.events()).toBe(1);

    // and byte-identical, so the signature still covers what the later build will read
    const served = joiner.ofKind("page")[0]?.events[0];
    expect(served).toEqual(forged);
    room.close();
  });
});

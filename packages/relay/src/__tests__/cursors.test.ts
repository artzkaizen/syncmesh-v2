import { createMemoryEventStore } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";
import { eventFrame } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import { joinFrame } from "../frames.js";
import { T0, entryOf, fakeSocket, openRoom, peer, tick, write } from "./fixtures.js";

const SECOND = Temporal.Duration.from({ seconds: 1 });

/** What the room told a fresh joiner it holds, per author. */
const helloCursors = (s: ReturnType<typeof fakeSocket>) => {
  const hello = s.ofKind("hello")[0];
  return hello === undefined ? [] : [...hello.cursors].map(([p, seq]) => `${p.slice(0, 6)}:${seq}`);
};

const joiner = async (room: Awaited<ReturnType<typeof openRoom>>, n: number) => {
  const s = fakeSocket();
  room.connect(s.socket).receive(joinFrame([1], peer(n, "acct_j").identity.peerId, new Map()));
  await tick();
  return s;
};

describe("what a room says it holds", () => {
  test("a hole the log cannot serve is below the cursor, not above it", async () => {
    const a = peer(40, "acct_a");
    const wires = [
      await write(a, "n1", "one"),
      await write(a, "n2", "two"),
      await write(a, "n3", "three"),
    ];

    // the log a shared host ends up with: its own write is stored without a signature
    // ("Own writes have none until they leave through a bridge" — engine/src/store.ts), and
    // `paged` drops exactly those, so the room can never hand seq 2 to anybody
    const store = createMemoryEventStore();
    // SAFETY: the three writes above
    const [w1, w2, w3] = wires as [Uint8Array, Uint8Array, Uint8Array];
    await store.append(entryOf(w1));
    await store.append({ event: entryOf(w2).event });
    await store.append(entryOf(w3));

    const room = await openRoom({ store });
    const s = await joiner(room, 200);
    expect(helloCursors(s)).toEqual([`${a.identity.peerId.slice(0, 6)}:1`]);
    // and the author, told that, offers the two the room is missing rather than nothing
    const hello = s.ofKind("hello")[0];
    const outstanding = (
      await a.engine.eventsSince(hello?.kind === "hello" ? hello.cursors : new Map())
    ).unwrap();
    expect(outstanding.map((e) => Number(e.event.seqNum))).toEqual([2, 3]);
    room.close();
  });

  test("a frame that arrives after a fatal refusal is not appended, and leaves no hole", async () => {
    const a = peer(40, "acct_a");
    let at = T0;
    const room = await openRoom({
      now: () => at,
      limits: { rates: { event: { burst: 1, every: SECOND }, blob: { burst: 1, every: SECOND } } },
    });
    const s = fakeSocket();
    const conn = room.connect(s.socket);
    conn.receive(joinFrame([1], a.identity.peerId, new Map())); // spends the one token
    await tick();

    const w1 = await write(a, "n1", "one");
    const w2 = await write(a, "n2", "two");
    conn.receive(eventFrame(w1)); // no token left: a typed refusal and a close
    await tick();
    expect(s.closedWith).toEqual(["rate"]);
    expect(room.offset()).toBe(0);

    at = T0.add({ seconds: 1 }); // a token refills while the close is still in flight
    conn.receive(eventFrame(w2)); // a frame the runtime had already buffered
    await tick();
    expect(room.offset()).toBe(0);

    const s2 = await joiner(room, 201);
    expect(helloCursors(s2)).toEqual([]);
    expect(s2.events()).toBe(0);
    room.close();
  });
});

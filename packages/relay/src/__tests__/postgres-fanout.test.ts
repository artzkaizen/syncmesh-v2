import { createMemoryEventStore, type EventStore } from "@syncmesh/engine";
import { grantFrame } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import { relayedFrame } from "../frames.js";
import { createGrantCache } from "../grant-cache.js";
import { postgresFanout } from "../postgres-fanout.js";
import { openRelayRoom } from "../room.js";
import { entryOf, mintFor, peer, until, write } from "./fixtures.js";

/** Postgres in one object: every listener on a channel hears every notify, the notifier included. */
const fakePostgres = () => {
  const channels = new Map<string, Set<(payload: string) => void>>();
  const notified: string[] = [];
  return {
    notified,
    listening: (channel: string) => channels.get(channel)?.size ?? 0,
    client: {
      listen: (channel: string, onPayload: (payload: string) => void) => {
        const held = channels.get(channel) ?? new Set<(payload: string) => void>();
        held.add(onPayload);
        channels.set(channel, held);
        return Promise.resolve(() => void held.delete(onPayload));
      },
      notify: (channel: string, payload: string) => {
        notified.push(channel);
        for (const listener of [...(channels.get(channel) ?? [])]) listener(payload);
        return Promise.resolve();
      },
    },
  };
};

describe("postgresFanout", () => {
  test("frames cross instances, never echo to their notifier, and rooms are separate channels", async () => {
    const pg = fakePostgres();
    const fanout = postgresFanout({ client: pg.client });
    const a = fanout.connect("main");
    const b = fanout.connect("main");
    const other = fanout.connect("jobs");

    const atA: number[] = [];
    const atB: number[] = [];
    const atOther: number[] = [];
    a.onFrame((f) => void atA.push(f.length));
    b.onFrame((f) => void atB.push(f.length));
    other.onFrame((f) => void atOther.push(f.length));
    await Promise.resolve();

    a.publish(Uint8Array.of(1, 2, 3));
    expect(atB).toEqual([3]); // the payload, tag stripped
    expect(atA).toEqual([]); // NOTIFY reached the notifying session; the link dropped it
    expect(atOther).toEqual([]); // another room is another channel

    b.publish(Uint8Array.of(9));
    expect(atA).toEqual([1]);
    expect(atB).toEqual([3]);
  });

  test("bytes survive the round trip, because a notification is text and a frame is not", async () => {
    const pg = fakePostgres();
    const fanout = postgresFanout({ client: pg.client });
    const a = fanout.connect("r");
    const b = fanout.connect("r");
    const heard: Uint8Array[] = [];
    b.onFrame((f) => void heard.push(f));
    await Promise.resolve();

    // every one of these is invalid UTF-8, which is what nearly every signed frame is: a round
    // trip through a string instead of base64 mangles them, and the corruption reads as a
    // fanout that silently drops traffic
    const frame = Uint8Array.of(0x00, 0xff, 0xfe, 0x80, 0xc0, 0x7f);
    a.publish(frame);
    expect(heard).toEqual([frame]);
  });

  test("a frame too large to carry sends a wake, so the instance that is behind knows it", async () => {
    const pg = fakePostgres();
    const oversize: number[] = [];
    const gaps: number[] = [];
    const fanout = postgresFanout({
      client: pg.client,
      onOversize: (n) => void oversize.push(n),
      onGap: () => void gaps.push(1),
    });
    const a = fanout.connect("r");
    const b = fanout.connect("r");
    const heard: number[] = [];
    b.onFrame((f) => void heard.push(f.length));
    await Promise.resolve();

    // Postgres caps a payload at 8000 bytes and base64 costs four for every three; reassembly
    // here would be a second delivery guarantee inside a transport that promises none
    a.publish(new Uint8Array(9000));
    expect(heard).toEqual([]); // no frame, because none would fit
    expect(oversize).toEqual([9000]); // the sender knows what it could not send
    expect(gaps).toEqual([1]); // and so does the instance that is now behind
    expect(pg.notified).toHaveLength(1); // a wake went out, not silence

    a.publish(Uint8Array.of(1));
    expect(heard).toEqual([1]); // and the link still works afterwards
  });

  test("a wake is not mistaken for a frame, and never reaches its own sender", async () => {
    const pg = fakePostgres();
    const gaps: number[] = [];
    const fanout = postgresFanout({ client: pg.client, onGap: () => void gaps.push(1) });
    const a = fanout.connect("r");
    const heard: number[] = [];
    a.onFrame((f) => void heard.push(f.length));
    await Promise.resolve();

    a.publish(new Uint8Array(9000));
    // the sender already knows it could not send: a wake echoed back to it would count the
    // same outage twice, once as a cause and once as a symptom
    expect(gaps).toEqual([]);
    expect(heard).toEqual([]); // and an empty frame is not what a wake is
  });

  test("close stops this link listening and leaves the other's standing", async () => {
    const pg = fakePostgres();
    const fanout = postgresFanout({ client: pg.client, prefix: "m" });
    const a = fanout.connect("r");
    const b = fanout.connect("r");
    a.onFrame(() => undefined);
    const atB: number[] = [];
    b.onFrame((f) => void atB.push(f.length));
    await Promise.resolve();

    a.close();
    await Promise.resolve();
    const lone = fanout.connect("r");
    lone.onFrame(() => undefined);
    await Promise.resolve();
    lone.publish(Uint8Array.of(5, 5));
    expect(atB).toEqual([2]); // b still hears the room
  });

  test("a LISTEN acknowledged after close is released, not kept", async () => {
    const pg = fakePostgres();
    let acknowledge = (): void => undefined;
    let released = false;
    const slow = {
      ...pg.client,
      listen: (channel: string, onPayload: (payload: string) => void) =>
        new Promise<() => void>((resolve) => {
          acknowledge = () =>
            void pg.client.listen(channel, onPayload).then((off) =>
              resolve(() => {
                released = true;
                off();
              }),
            );
        }),
    };
    const link = postgresFanout({ client: slow, prefix: "m" }).connect("r");
    link.onFrame(() => undefined);
    link.close(); // while the LISTEN is still pending
    acknowledge();
    await link.heard?.();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(released).toBe(true);
  });
});

describe("a room opened over postgresFanout", () => {
  test("is not served until its LISTEN is acknowledged (gaps U41)", async () => {
    const pg = fakePostgres();
    let acknowledge = (): void => undefined;
    const slow = {
      ...pg.client,
      listen: (channel: string, onPayload: (payload: string) => void) =>
        new Promise<() => void>((resolve) => {
          acknowledge = () => void pg.client.listen(channel, onPayload).then(resolve);
        }),
    };
    let opened = false;
    const opening = openRelayRoom({
      name: "main",
      store: createMemoryEventStore(),
      epoch: "e",
      keepaliveMs: 60_000,
      fanout: postgresFanout({ client: slow }),
    }).then((room) => {
      opened = true;
      return room.unwrap();
    });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(opened).toBe(false);
    acknowledge();
    const room = await opening;
    expect(opened).toBe(true);
    room.close();
  });

  test("hears what was fanned out before it opened, from the instance already serving it (gaps U41)", async () => {
    const pg = fakePostgres();
    const fanout = postgresFanout({ client: pg.client });
    const open = (store = createMemoryEventStore(), grants = createGrantCache()) =>
      openRelayRoom({ name: "main", store, grants, epoch: "e", keepaliveMs: 60_000, fanout });
    const serving = (await open()).unwrap();

    // a third instance fans out a grant and an event; only the room already open hears them
    const alice = peer(2, "acct_alice");
    const grant = mintFor(alice.identity, "acct_alice");
    const event = await write(alice, "n1", "before");
    const third = fanout.connect("main");
    third.onFrame(() => undefined);
    third.publish(grantFrame(grant));
    third.publish(relayedFrame(event, 1));
    expect(await until(() => serving.offset() === 1)).toBe(true);

    const store = createMemoryEventStore();
    const grants = createGrantCache();
    const opened = (await open(store, grants)).unwrap();
    expect(await until(() => opened.offset() === 1)).toBe(true);
    expect((await store.all()).unwrap().map((entry) => entry.event.id)).toHaveLength(1);
    expect(grants.all()).toEqual([grant]);
    // and the room already serving took nothing twice from the answer it overheard
    expect(serving.offset()).toBe(1);
    for (const room of [serving, opened]) room.close();
    third.close();
  });

  test("is answered when its log names more authors than one notification holds (gaps U41)", async () => {
    const pg = fakePostgres();
    const oversize: number[] = [];
    const fanout = postgresFanout({
      client: pg.client,
      onOversize: (bytes) => oversize.push(bytes),
    });
    // 250 authors at 40-odd bytes of cursor each: a whole greeting is past Postgres's 8000 bytes
    const authors = Array.from({ length: 250 }, (_, i) => peer(3 + i, `acct_${i}`));
    const first = await Promise.all(authors.map((author, i) => write(author, `n${i}`, "held")));
    const missed = await write(authors[0]!, "late", "missed");
    const holding = async (wires: readonly Uint8Array[]) => {
      const store = createMemoryEventStore();
      (await store.appendBatch(wires.map(entryOf))).unwrap();
      return store;
    };
    const open = (store: EventStore) =>
      openRelayRoom({ name: "main", store, epoch: "e", keepaliveMs: 60_000, fanout });
    const serving = (await open(await holding([...first, missed]))).unwrap();

    const opened = (await open(await holding(first))).unwrap();
    expect(await until(() => opened.offset() === 251, 20_000)).toBe(true);
    expect(oversize).toEqual([]);
    for (const room of [serving, opened]) room.close();
  }, 60_000); // 250 signing identities take seconds to derive before a room opens
});

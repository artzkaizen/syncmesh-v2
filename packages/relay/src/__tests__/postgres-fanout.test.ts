import { describe, expect, test } from "bun:test";

import { postgresFanout } from "../postgres-fanout.js";

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

  test("a frame too large for a notification is dropped loudly, never split", async () => {
    const pg = fakePostgres();
    const oversize: number[] = [];
    const fanout = postgresFanout({ client: pg.client, onOversize: (n) => void oversize.push(n) });
    const a = fanout.connect("r");
    const b = fanout.connect("r");
    const heard: number[] = [];
    b.onFrame((f) => void heard.push(f.length));
    await Promise.resolve();

    // Postgres caps a payload at 8000 bytes and base64 costs four for every three; reassembly
    // here would be a second delivery guarantee inside a transport that promises none
    a.publish(new Uint8Array(9000));
    expect(heard).toEqual([]);
    expect(oversize).toEqual([9000]);
    expect(pg.notified).toEqual([]);

    a.publish(Uint8Array.of(1));
    expect(heard).toEqual([1]); // and the link still works afterwards
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
});

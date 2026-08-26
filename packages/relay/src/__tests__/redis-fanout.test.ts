import { describe, expect, test } from "bun:test";

import { redisFanout } from "../redis-fanout.js";

/** Redis in one object: every subscriber hears every publish on the channel, publisher included. */
const fakeRedis = () => {
  const channels = new Map<string, Set<(message: Uint8Array) => void>>();
  const published: string[] = [];
  return {
    published,
    publisher: {
      publish: (channel: string, message: Uint8Array) => {
        published.push(channel);
        for (const listener of channels.get(channel) ?? []) listener(Uint8Array.from(message));
        return Promise.resolve(1);
      },
    },
    subscriber: {
      subscribe: (channel: string, listener: (message: Uint8Array) => void) => {
        const held = channels.get(channel) ?? new Set<(message: Uint8Array) => void>();
        held.add(listener);
        channels.set(channel, held);
        return Promise.resolve(undefined);
      },
      unsubscribe: (channel: string, listener?: (message: Uint8Array) => void) => {
        if (listener !== undefined) channels.get(channel)?.delete(listener);
        else channels.delete(channel);
        return Promise.resolve(undefined);
      },
      count: (channel: string) => channels.get(channel)?.size ?? 0,
    },
  };
};

describe("redisFanout", () => {
  test("frames cross instances, never echo to their publisher, and rooms are separate channels", async () => {
    const redis = fakeRedis();
    const fanout = redisFanout({ publisher: redis.publisher, subscriber: redis.subscriber });
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
    expect(atA).toEqual([]); // Redis echoed it; the link did not
    expect(atOther).toEqual([]); // another room is another channel
    expect(redis.published).toEqual(["syncmesh:main"]);

    b.publish(Uint8Array.of(9));
    expect(atA).toEqual([1]);
    expect(atB).toEqual([3]);
  });

  test("close unsubscribes this link's listener and leaves the other's standing", async () => {
    const redis = fakeRedis();
    const fanout = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriber,
      prefix: "m",
    });
    const a = fanout.connect("r");
    const b = fanout.connect("r");
    a.onFrame(() => undefined);
    const atB: number[] = [];
    b.onFrame((f) => void atB.push(f.length));
    await Promise.resolve();
    expect(redis.subscriber.count("m:r")).toBe(2);

    a.close();
    await Promise.resolve();
    expect(redis.subscriber.count("m:r")).toBe(1);
    const lone = fanout.connect("r");
    await Promise.resolve();
    lone.publish(Uint8Array.of(5, 5));
    expect(atB).toEqual([2]); // b still hears the room
  });
});

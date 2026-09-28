import { describe, expect, test } from "bun:test";

import type { DevtoolsChannel } from "../contract.js";

import { createChannels } from "../source/channels.js";

/**
 * The coalescer is the whole cost argument, so the tests are about *how many* notifications come
 * out rather than what is in them: a hundred folds in a tick must be one repaint, and a source
 * nobody is watching must do nothing at all.
 */

/** A schedule a test drives by hand, so "one microtask later" is an assertion and not a sleep. */
const manual = () => {
  const queued: (() => void)[] = [];
  return {
    schedule: (flush: () => void) => void queued.push(flush),
    run: () => {
      const held = [...queued];
      queued.length = 0;
      for (const flush of held) flush();
    },
    depth: () => queued.length,
  };
};

const record = () => {
  const seen: ReadonlySet<DevtoolsChannel>[] = [];
  return { seen, listener: (moved: ReadonlySet<DevtoolsChannel>) => void seen.push(moved) };
};

describe("the coalesced feed", () => {
  test("a hundred folds in one tick are one notification", () => {
    const clock = manual();
    const channels = createChannels({ schedule: clock.schedule });
    const { seen, listener } = record();
    channels.subscribe(listener);
    for (let n = 0; n < 100; n += 1) channels.moved("fold");
    expect(seen).toHaveLength(0);
    expect(clock.depth()).toBe(1);
    clock.run();
    expect(seen).toEqual([new Set(["fold"])]);
  });

  test("channels that moved together arrive together, as a set", () => {
    const clock = manual();
    const channels = createChannels({ schedule: clock.schedule });
    const { seen, listener } = record();
    channels.subscribe(listener);
    channels.moved("fold");
    channels.moved("ack");
    channels.moved("fold");
    clock.run();
    expect(seen).toEqual([new Set(["fold", "ack"])]);
  });

  test("nothing is recorded while nobody is listening", () => {
    const clock = manual();
    const channels = createChannels({ schedule: clock.schedule });
    channels.moved("fold");
    expect(clock.depth()).toBe(0);
    const { seen, listener } = record();
    channels.subscribe(listener);
    clock.run();
    // the fold happened before anyone was watching; delivering it now would be a stale burst
    expect(seen).toHaveLength(0);
  });

  test("the next tick starts empty, so a channel is not re-announced", () => {
    const clock = manual();
    const channels = createChannels({ schedule: clock.schedule });
    const { seen, listener } = record();
    channels.subscribe(listener);
    channels.moved("fold");
    clock.run();
    channels.moved("ack");
    clock.run();
    expect(seen).toEqual([new Set(["fold"]), new Set(["ack"])]);
  });

  test("one listener that throws does not silence the next", () => {
    const clock = manual();
    const thrown: unknown[] = [];
    const channels = createChannels({
      schedule: clock.schedule,
      onError: (cause) => void thrown.push(cause),
    });
    const { seen, listener } = record();
    channels.subscribe(() => {
      throw new Error("a panel's listener blew up");
    });
    channels.subscribe(listener);
    channels.moved("link");
    clock.run();
    expect(seen).toEqual([new Set(["link"])]);
    expect(thrown).toHaveLength(1);
  });

  test("unsubscribing stops delivery; closing stops everything", () => {
    const clock = manual();
    const channels = createChannels({ schedule: clock.schedule });
    const { seen, listener } = record();
    const off = channels.subscribe(listener);
    off();
    channels.moved("fold");
    clock.run();
    expect(seen).toHaveLength(0);

    channels.subscribe(listener);
    channels.close();
    channels.moved("fold");
    clock.run();
    expect(seen).toHaveLength(0);
  });
});

import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { FeedState } from "../commits.js";
import type { ChangeStream } from "../source.js";

import { commitFeed, resumableCommitFeed } from "../commits.js";
import { manualChangeSource } from "../manual.js";

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
};

describe("commitFeed: the tables each commit touched (D43)", () => {
  test("one call per commit, naming every table it touched, and each commit acked", async () => {
    const source = manualChangeSource({ name: "db" });
    const feed = commitFeed(await source.start({ after: null }));
    const seen: string[][] = [];
    feed.onCommit((tables) => seen.push([...tables].sort()));
    source.commit((tx) => {
      tx.insert("mail", { id: "m1" });
      tx.update("calls", "c1", { id: "c1" });
      tx.delete("mail", "m0");
    });
    source.commit((tx) => tx.truncate("calls"));
    await until(() => seen.length === 2);
    expect(seen).toEqual([["calls", "mail"], ["calls"]]);
    expect(source.pending()).toBe(0);
    feed.stop();
    expect((await feed.done).isOk()).toBe(true);
  });

  test("a stream that fails ends the feed with the source's error", async () => {
    const feed = commitFeed(
      {
        changes: (async function* () {
          yield { t: "begin" } as const;
          throw new Error("slot lost");
        })(),
        ack: () => {},
        stop: () => {},
      },
      "pg",
    );
    const done = await feed.done;
    expect(done.isErr() && done.error.message).toBe("slot lost");
  });
});

/** A stream that begins a transaction and fails inside it, as a slot that was dropped does. */
const failing = (message: string): ChangeStream => ({
  changes: (async function* () {
    yield { t: "begin" } as const;
    throw new Error(message);
  })(),
  ack: () => {},
  stop: () => {},
});

const QUICK = {
  first: Temporal.Duration.from({ milliseconds: 1 }),
  most: Temporal.Duration.from({ milliseconds: 4 }),
} as const;

describe("resumableCommitFeed: a feed that outlives its stream (D43)", () => {
  test("a failed stream is told as lost, started again, told as resumed, and its commits heard", async () => {
    const source = manualChangeSource({ name: "db" });
    let starts = 0;
    // the stream fails, then the database refuses the next start, then it is back
    const start = async () => {
      starts++;
      if (starts === 1) return failing("slot lost");
      if (starts === 2) throw new Error("connection refused");
      return source.start({ after: null });
    };
    const feed = resumableCommitFeed(start, { retry: QUICK });
    const states: FeedState[] = [];
    const seen: string[][] = [];
    feed.onFeed((state) => states.push(state));
    feed.onCommit((tables) => seen.push([...tables]));
    await until(() => states.length === 2);
    // told once that it went, however many starts fail, and once that it is back
    expect(states).toEqual([{ kind: "lost", reason: "slot lost" }, { kind: "resumed" }]);
    expect(starts).toBe(3);
    source.commit((tx) => tx.insert("mail", { id: "m1" }));
    await until(() => seen.length === 1);
    expect(seen).toEqual([["mail"]]);
    feed.stop();
    await feed.done;
  });

  test("stop ends the wait between starts rather than sitting out the backoff", async () => {
    const slow = {
      first: Temporal.Duration.from({ minutes: 10 }),
      most: Temporal.Duration.from({ minutes: 10 }),
    } as const;
    const feed = resumableCommitFeed(async () => failing("slot lost"), { retry: slow });
    const states: FeedState[] = [];
    feed.onFeed((state) => states.push(state));
    await until(() => states.length === 1);
    feed.stop();
    await feed.done;
    expect(states).toEqual([{ kind: "lost", reason: "slot lost" }]);
  });
});

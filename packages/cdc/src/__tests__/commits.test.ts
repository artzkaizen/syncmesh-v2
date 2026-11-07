import { describe, expect, test } from "bun:test";

import { commitFeed } from "../commits.js";
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

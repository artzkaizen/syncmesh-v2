import { describe, expect, test } from "bun:test";

import { createGate } from "../gate.js";

/** A turn that records its start and end, and ends when released. */
const step = (log: string[], name: string) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return {
    run: async () => {
      log.push(`${name} start`);
      await promise;
      log.push(`${name} end`);
    },
    release: () => resolve(),
  };
};

const tick = () => new Promise((settled) => setImmediate(settled));

describe("createGate", () => {
  test("shared turns run side by side", async () => {
    const gate = createGate();
    const log: string[] = [];
    const one = step(log, "one");
    const two = step(log, "two");
    const both = [gate.shared(one.run), gate.shared(two.run)];
    await tick();
    expect(log).toEqual(["one start", "two start"]);
    one.release();
    two.release();
    await Promise.all(both);
  });

  test("an exclusive turn waits for the running shared turns, and holds back later ones", async () => {
    const gate = createGate();
    const log: string[] = [];
    const before = step(log, "before");
    const alone = step(log, "alone");
    const after = step(log, "after");
    const turns = [gate.shared(before.run), gate.exclusive(alone.run), gate.shared(after.run)];
    await tick();
    expect(log).toEqual(["before start"]);
    before.release();
    await tick();
    expect(log).toEqual(["before start", "before end", "alone start"]);
    alone.release();
    await tick();
    expect(log).toEqual(["before start", "before end", "alone start", "alone end", "after start"]);
    after.release();
    await Promise.all(turns);
  });

  test("a failed exclusive turn does not hold the gate shut", async () => {
    const gate = createGate();
    const failed = gate.exclusive(() => Promise.reject(new Error("no")));
    expect(await failed.then(String, (cause: Error) => cause.message)).toBe("no");
    expect(await gate.shared(() => Promise.resolve("open"))).toBe("open");
  });
});

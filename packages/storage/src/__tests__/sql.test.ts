import { describe, expect, test } from "bun:test";

import type { SqlDriver } from "../driver.js";

import { POSTGRES, SQLITE, dialectOf } from "../dialect.js";
import { inTransaction } from "../sql.js";

/** A driver that records the order its transactions opened and closed, and can be held open. */
const recording = () => {
  const trace: string[] = [];
  let depth = 0;
  const driver: SqlDriver = {
    run: () => Promise.resolve(),
    all: () => Promise.resolve([]),
    transaction: async (fn) => {
      depth += 1;
      if (depth > 1) throw new Error("a second transaction opened inside another");
      trace.push("begin");
      try {
        const out = await fn();
        trace.push("commit");
        return out;
      } catch (cause) {
        trace.push("rollback");
        throw cause;
      } finally {
        depth -= 1;
      }
    },
  };
  return { driver, trace };
};

describe("inTransaction", () => {
  test("serializes per driver in call order, so two writers take turns on one connection", async () => {
    const { driver, trace } = recording();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    // the first transaction stays open; the second must wait rather than nest
    const first = inTransaction(driver, async () => {
      trace.push("first body");
      await held;
      return "first";
    });
    const second = inTransaction(driver, () => {
      trace.push("second body");
      return Promise.resolve("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(trace).toEqual(["begin", "first body"]); // the second has not begun

    release();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(trace).toEqual(["begin", "first body", "commit", "begin", "second body", "commit"]);
  });

  test("a failed transaction does not wedge the queue behind it", async () => {
    const { driver, trace } = recording();
    const failed = inTransaction(driver, () => Promise.reject(new Error("disk full"))).then(
      () => "resolved",
      (cause: unknown) => String(cause),
    );
    const after = inTransaction(driver, () => Promise.resolve("still works"));
    expect(await failed).toContain("disk full");
    expect(await after).toBe("still works");
    expect(trace).toEqual(["begin", "rollback", "begin", "commit"]);
  });

  test("a driver with no transaction support runs the body as it is", async () => {
    const bare: SqlDriver = { run: () => Promise.resolve(), all: () => Promise.resolve([]) };
    expect(await inTransaction(bare, () => Promise.resolve(7))).toBe(7);
  });
});

describe("dialectOf", () => {
  test("an undeclared dialect is SQLite — the on-device default", () => {
    const bare: SqlDriver = { run: () => Promise.resolve(), all: () => Promise.resolve([]) };
    expect(dialectOf(bare)).toBe(SQLITE);
    expect(dialectOf({ ...bare, dialect: "sqlite" })).toBe(SQLITE);
    expect(dialectOf({ ...bare, dialect: "postgres" })).toBe(POSTGRES);
  });

  test("each dialect owns its statements outright — no string pretends to be both SQLs", () => {
    expect(SQLITE.events.insert).toContain("INSERT OR IGNORE");
    expect(POSTGRES.events.insert).toContain("ON CONFLICT");
    expect(SQLITE.placeholder(2)).toBe("?");
    expect(POSTGRES.placeholder(2)).toBe("$2");
    // the same keys on both sides, so a store written once cannot reach for a missing one
    expect(Object.keys(SQLITE.events).sort()).toEqual(Object.keys(POSTGRES.events).sort());
    expect(Object.keys(SQLITE.state).sort()).toEqual(Object.keys(POSTGRES.state).sort());
  });

  test("a cell takes the form its dialect stores: SQLite has no boolean or date, Postgres has both", () => {
    expect(SQLITE.cell("boolean", true)).toBe(1);
    expect(POSTGRES.cell("boolean", true)).toBe(true);
    expect(SQLITE.cell("timestamp", 1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(POSTGRES.cell("timestamp", 1_700_000_000_000)).toEqual(new Date(1_700_000_000_000));
    for (const dialect of [SQLITE, POSTGRES]) {
      expect(dialect.cell("text", null)).toBeNull();
      expect(dialect.cell("json", { a: 1 })).toBe('{"a":1}');
    }
  });
});

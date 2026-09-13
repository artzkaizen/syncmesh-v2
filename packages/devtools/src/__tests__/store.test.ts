import { describe, expect, test } from "bun:test";

import type { SqlRow } from "../contract.js";

import { refusalFor } from "../source/sql.js";
import { createStoreReader } from "../source/store.js";

/**
 * Two dialects, two sets of table names, and nothing on `Mesh` that says which is underneath. The
 * tests are therefore mostly about the probe, and about which failures are allowed to blank a
 * panel: a missing write ledger is not one, and a log nobody can count is.
 */

const LOG = [["9da8", 0, 412, 412, 184_320]] satisfies SqlRow[];

/** A driver that answers the statements it knows and rejects everything else, recording the lot. */
const driver = (known: Record<string, readonly SqlRow[]>) => {
  const asked: string[] = [];
  return {
    asked,
    query: (sql: string) => {
      asked.push(sql);
      const answer = known[sql];
      return answer === undefined
        ? Promise.reject(new Error(`no such table, for: ${sql}`))
        : Promise.resolve(answer);
    },
  };
};

const SQLITE_LOG =
  "SELECT peer, local, COUNT(*), MAX(seq), SUM(length(core)) FROM events GROUP BY peer, local";
const POSTGRES_LOG =
  "SELECT peer, local, COUNT(*), MAX(seq), SUM(length(core)) FROM _syncmesh_events GROUP BY peer, local";

describe("the storage reader", () => {
  test("reads the device's short names when the device answers to them", async () => {
    const fake = driver({ [SQLITE_LOG]: LOG, "PRAGMA user_version": [[4]] });
    const held = await createStoreReader(fake.query)();
    expect(held.isOk()).toBe(true);
    expect(held.unwrap().log).toEqual([
      { peer: "9da8", local: false, events: 412, topSeq: 412, bytes: 184_320 },
    ]);
    expect(held.unwrap().version).toBe(4);
  });

  test("falls back to the prefixed names, because `events` is somebody's table in Postgres", async () => {
    const fake = driver({ [POSTGRES_LOG]: LOG });
    const held = await createStoreReader(fake.query)();
    expect(held.isOk()).toBe(true);
    expect(fake.asked).toContain(SQLITE_LOG);
    expect(fake.asked.some((sql) => sql.includes("_syncmesh_state"))).toBe(true);
  });

  test("the probe runs once; the answer is remembered", async () => {
    const fake = driver({ [POSTGRES_LOG]: LOG });
    const read = createStoreReader(fake.query);
    await read();
    const first = fake.asked.filter((sql) => sql === SQLITE_LOG).length;
    await read();
    expect(fake.asked.filter((sql) => sql === SQLITE_LOG)).toHaveLength(first);
  });

  test("a hint skips the probe entirely", async () => {
    const fake = driver({ [POSTGRES_LOG]: LOG });
    await createStoreReader(fake.query, "postgres")();
    expect(fake.asked).not.toContain(SQLITE_LOG);
  });

  test("a mesh with no write ledger still renders every other number", async () => {
    const fake = driver({ [SQLITE_LOG]: LOG });
    const held = await createStoreReader(fake.query, "sqlite")();
    // `operations` does not exist here and that is not a reason to blank the panel
    expect(held.isOk()).toBe(true);
    expect(held.unwrap().writes).toEqual([]);
    expect(held.unwrap().version).toBeUndefined();
  });

  test("a log nobody can count is a failure, as a value", async () => {
    const fake = driver({});
    const held = await createStoreReader(fake.query, "sqlite")();
    expect(held.isErr()).toBe(true);
  });

  test("every statement it runs would pass the read-only door", async () => {
    const fake = driver({ [SQLITE_LOG]: LOG });
    await createStoreReader(fake.query, "sqlite")();
    // the weight of the log, never the log: `length(core)` and not `core`
    for (const sql of fake.asked) expect(refusalFor(sql)).toBeUndefined();
  });
});

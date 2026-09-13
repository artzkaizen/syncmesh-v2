import type { FoldBatch } from "@syncmesh/engine";
import type { TableName } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { LiveSource, Runnable } from "../live.js";

import { createLive } from "../live.js";

const jobs = sqliteTable("jobs", { id: text().primaryKey() });

// SAFETY: the brand is a compile-time tag over the table's own name, which is what the engine
// puts in a batch; there is no constructor for it and nothing reads it back out
const JOBS = "jobs" as TableName;

const batch = {
  source: "local",
  eventCount: 1,
  writeTables: new Set([JOBS]),
  writeKeys: new Map(),
} satisfies FoldBatch;

/** A fold feed with a handle on it, so a test can announce the batch a re-run waits for. */
const feed = () => {
  const folds = new Set<(fold: FoldBatch) => void>();
  const source: LiveSource = {
    onFoldBatch: (listener) => {
      folds.add(listener);
      return () => void folds.delete(listener);
    },
    onAcknowledge: () => () => undefined,
  };
  return { source, fold: () => folds.forEach((run) => run(batch)) };
};

/**
 * A query over `jobs` whose every run is whatever the test says it is that time.
 *
 * The SQL names the table rather than being a string, because that is what a live query walks to
 * decide which folds are its own — a query over no table would never re-run.
 */
const answering = <T>(runs: readonly (() => Promise<readonly T[]>)[]): Runnable<T> => {
  let at = 0;
  const next = () => runs[at++] ?? runs.at(-1) ?? (() => Promise.resolve([]));
  return {
    getSQL: () => sql`select id from ${jobs}`,
    // oxlint-disable-next-line unicorn/no-thenable -- a Drizzle query *is* the thenable a live query awaits; a stand-in for one has to be one
    then: (onValue, onError) => next()().then(onValue, onError),
  };
};

/**
 * `answered` is the fact an empty-state claim rests on, and it is not any of the other three.
 *
 * A screen that says "there is no such thing here" is making a statement about this device's
 * storage, and the only evidence for it is a read that ran and came back with nothing. `status`
 * cannot stand in: it is `error` for a read that fell over — establishing nothing in either
 * direction — and a caller reading `!isPending` takes that for an answer and draws a confident
 * empty state over a store it never heard from.
 */
describe("a snapshot says whether the store answered", () => {
  const boom = () => Promise.reject(new Error("the port closed mid-query"));

  test("a query that has not run has not answered", async () => {
    const { source } = feed();
    const live = createLive(source)(answering([() => Promise.resolve([{ id: "j1" }])]));
    expect(live.snapshot()).toEqual({
      answered: false,
      data: [],
      error: undefined,
      status: "pending",
    });
    await live.ready;
    expect(live.snapshot().answered).toBe(true);
    live.release();
  });

  test("a first run that threw leaves the store unheard from, not empty", async () => {
    const { source } = feed();
    const live = createLive(source)(answering([boom]));
    await live.ready.catch(() => undefined);
    const snap = live.snapshot();
    // not pending and not successful — the two facts a caller would otherwise read as "ready"
    expect(snap.status).toBe("error");
    expect(snap.data).toEqual([]);
    expect(snap.answered).toBe(false);
    live.release();
  });

  test("a re-run that threw keeps the rows it had, and keeps having answered", async () => {
    const { source, fold } = feed();
    const live = createLive(source)(answering([() => Promise.resolve([{ id: "j1" }]), boom]));
    await live.ready;

    const settled = new Promise<void>((resolve) => live.subscribe(() => resolve()));
    fold();
    await settled;

    const snap = live.snapshot();
    expect(snap.status).toBe("error");
    expect(snap.data).toEqual([{ id: "j1" }]);
    // the question was answered once and a failed re-run does not un-answer it
    expect(snap.answered).toBe(true);
    live.release();
  });
});

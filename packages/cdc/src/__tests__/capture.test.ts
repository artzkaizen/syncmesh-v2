import type { Engine } from "@syncmesh/engine";
import type { PartitionKey, SyncEvent } from "@syncmesh/kernel";

import { StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { describe, expect, test } from "bun:test";

import type { ManualChangeSource } from "../manual.js";

import { startCapture } from "../capture.js";
import { manualChangeSource } from "../manual.js";
import { storedWatermark } from "../watermark.js";
import {
  ACME,
  GLOBEX,
  TASKS,
  authority,
  failure,
  mappings,
  peerAt,
  phone,
  rowsOf,
  until,
} from "./fixtures.js";

const CDC = "_cdc";

const outboundOf = (engine: Engine) => {
  const events: SyncEvent[] = [];
  engine.onOutbound((event) => void events.push(event));
  return events;
};

const inPartition = (events: readonly SyncEvent[], partition: PartitionKey) =>
  events.filter((event) => event.partition === partition);

const carriesWatermark = (event: SyncEvent) =>
  event.changes.some((change) => String(change.table) === CDC);

const bridge = async (engine: Engine, source: ManualChangeSource, truncateLimit?: number) =>
  (
    await startCapture(
      truncateLimit === undefined
        ? { engine, source, mappings }
        : { engine, source, mappings, truncateLimit },
    )
  ).unwrap();

const task = (id: string, orgId: string, title: string) => ({
  id,
  orgId,
  title,
  ownerId: "acct_alice",
});

describe("a transaction is an event boundary", () => {
  test("a three-row transaction becomes exactly one event per partition touched", async () => {
    const engine = peerAt(authority);
    const events = outboundOf(engine);
    const source = manualChangeSource({ name: "app" });
    const running = await bridge(engine, source);

    source.commit((tx) => {
      tx.insert("tasks", task("t1", "acme", "wire the panel"));
      tx.insert("tasks", task("t2", "acme", "test the loop"));
      tx.insert("tasks", task("t3", "globex", "read the meter"));
    });
    await until(() => source.pending() === 0, "the transaction to be captured and acked");
    running.stop();
    const report = (await running.done).unwrap();

    // two partitions, then the watermark on its own unpinned event: a position is about the
    // source, and pinning it to whichever instance went last is a partition two peers can
    // disagree about forever
    expect(events).toHaveLength(3);
    expect(events.at(-1)?.partition).toBeUndefined();
    expect(inPartition(events, ACME)).toHaveLength(1);
    expect(inPartition(events, GLOBEX)).toHaveLength(1);
    expect(report).toMatchObject({ transactions: 1, events: 2 });
    expect(engine.rowsIn(TASKS, ACME).size).toBe(2);
    expect(engine.rowsIn(TASKS, GLOBEX).size).toBe(1);
  });

  test("the watermark rides the last event, so the ack can only follow a durable one", async () => {
    const engine = peerAt(authority);
    const events = outboundOf(engine);
    const source = manualChangeSource({ name: "app" });
    const running = await bridge(engine, source);

    const at = source.commit((tx) => {
      tx.insert("tasks", task("t1", "acme", "one"));
      tx.insert("tasks", task("t3", "globex", "two"));
    });
    await until(() => source.pending() === 0, "the ack");
    running.stop();
    await running.done;

    expect(events.filter(carriesWatermark)).toHaveLength(1);
    // partitions are planned in sorted order, so the last event is the one that carries it
    expect(carriesWatermark(events[events.length - 1] ?? events[0]!)).toBe(true);
    expect(storedWatermark(engine, "app")).toBe(at);
  });

  test("many rows of one instance are still one event", async () => {
    const engine = peerAt(authority);
    const events = outboundOf(engine);
    const source = manualChangeSource({ name: "app" });
    const running = await bridge(engine, source);

    source.commit((tx) => {
      tx.insert("tasks", task("t1", "acme", "a"));
      tx.insert("tasks", task("t2", "acme", "b"));
      tx.insert("tasks", task("t3", "acme", "c"));
    });
    await until(() => source.pending() === 0, "the ack");
    running.stop();
    await running.done;

    expect(events).toHaveLength(2); // the changes, then the unpinned watermark
    expect(events[0]?.changes).toHaveLength(3); // the three rows, in one commit
    expect(events[1]?.partition).toBeUndefined(); // the watermark, about the source and no instance
  });
});

/**
 * The failure the epic names: an event is committed, the process dies before the ack. The
 * watermark rides the *last* event, so a crash part way through a multi-partition transaction
 * leaves it behind the work, and the restart replays the whole transaction.
 */
describe("a crash between event-commit and ack", () => {
  /** An engine that refuses the nth write, which is a crash the test can place exactly. */
  const failingOn = (engine: Engine, nth: number): Engine => {
    let calls = 0;
    return {
      ...engine,
      mutate: (procedure, fn, options) => {
        calls += 1;
        if (calls !== nth) return engine.mutate(procedure, fn, options);
        return Promise.resolve(Result.err(new StoreFailure({ message: "the process died" })));
      },
    };
  };

  test("replays the transaction and both peers still agree", async () => {
    const engine = peerAt(authority);
    const events = outboundOf(engine);
    const source = manualChangeSource({ name: "app" });

    const at = source.commit((tx) => {
      tx.insert("tasks", task("t1", "acme", "wire the panel"));
      tx.insert("tasks", task("t3", "globex", "read the meter"));
    });
    // the second event — globex, the one carrying the watermark — never lands
    const first = await bridge(failingOn(engine, 2), source);
    expect(failure(await first.done)._tag).toBe("EventRefused");
    // acme is written, globex is not, and nothing was acked or recorded
    expect(inPartition(events, ACME)).toHaveLength(1);
    expect(inPartition(events, GLOBEX)).toHaveLength(0);
    expect(storedWatermark(engine, "app")).toBeNull();
    expect(source.pending()).toBe(1);

    const second = await bridge(engine, source);
    await until(() => source.pending() === 0, "the replayed transaction to be acked");
    second.stop();
    await second.done;

    // acme got the same values twice; globex got them once; the watermark is now durable
    expect(inPartition(events, ACME)).toHaveLength(2);
    expect(inPartition(events, GLOBEX)).toHaveLength(1);
    expect(storedWatermark(engine, "app")).toBe(at);
    expect(rowsOf(engine, ACME, TASKS)).toEqual([
      ["t1", { id: "t1", orgId: "acme", title: "wire the panel", ownerId: "acct_alice" }],
    ]);

    // and a peer folding every one of those events, replay included, reaches the same rows
    const peer = peerAt(phone);
    (await peer.receiveBatch((await engine.eventsSince(new Map())).unwrap())).unwrap();
    expect(rowsOf(peer, ACME, TASKS)).toEqual(rowsOf(engine, ACME, TASKS));
    expect(rowsOf(peer, GLOBEX, TASKS)).toEqual(rowsOf(engine, GLOBEX, TASKS));

    // digests, not just the app rows: comparing the tables alone is what let a `_cdc` row pinned
    // to a rotating partition ship green — the rows agreed and the records did not, because a
    // record's partition is hashed into its digest and is first-seen-wins, not stamp-ordered
    expect([...peer.digest()]).toEqual([...engine.digest()]);
    expect(storedWatermark(peer, "app")).toBe(storedWatermark(engine, "app"));
  });

  test("a watermark that survives a restart neither skips nor duplicates", async () => {
    const engine = peerAt(authority);
    const events = outboundOf(engine);
    const source = manualChangeSource({ name: "app" });

    const first = await bridge(engine, source);
    source.commit((tx) => tx.insert("tasks", task("t1", "acme", "before")));
    await until(() => source.pending() === 0, "the first ack");
    first.stop();
    await first.done;
    expect(events).toHaveLength(2); // the changes, then the unpinned watermark

    // the bridge restarts and resumes from the row, not from the beginning
    const second = await bridge(engine, source);
    const at = source.commit((tx) => tx.insert("tasks", task("t2", "acme", "after")));
    await until(() => source.pending() === 0, "the second ack");
    second.stop();
    expect((await second.done).unwrap()).toMatchObject({ transactions: 1, events: 1 });

    // two transactions, each a change event and then its watermark on an unpinned event of its
    // own: a position is about the source, and pinning it to whichever instance a transaction
    // happened to touch last is a partition two peers can disagree about forever
    expect(events).toHaveLength(4);
    expect(events.at(-1)?.partition).toBeUndefined();
    expect(events.filter((e) => e.partition === undefined)).toHaveLength(2);
    expect(storedWatermark(engine, "app")).toBe(at);
    expect(engine.rowsIn(TASKS, ACME).size).toBe(2);
  });
});

describe("what the stream may not tell us to do", () => {
  test("a schema change is an alarm, never an instruction", async () => {
    const engine = peerAt(authority);
    const source = manualChangeSource({ name: "app" });
    const running = await bridge(engine, source);

    source.schemaChanged("tasks", "ADD COLUMN priority integer");
    const stopped = failure(await running.done);

    expect(stopped._tag).toBe("SchemaDrift");
    expect(engine.state().has(TASKS)).toBe(false);
  });

  test("truncate is refused without an opt-in, and over the cap", async () => {
    const engine = peerAt(authority);
    const source = manualChangeSource({ name: "app" });
    const seeded = await bridge(engine, source);
    source.commit((tx) => {
      tx.insert("tasks", task("t1", "acme", "a"));
      tx.insert("tasks", task("t2", "acme", "b"));
    });
    await until(() => source.pending() === 0, "the seed");
    seeded.stop();
    await seeded.done;

    source.commit((tx) => tx.truncate("tasks"));
    const unopted = await bridge(engine, source);
    expect(failure(await unopted.done)._tag).toBe("TruncateRefused");

    const capped = await bridge(engine, source, 1);
    const over = failure(await capped.done);
    expect(over).toMatchObject({ _tag: "TruncateRefused", rows: 2, limit: 1 });
    expect(engine.rowsIn(TASKS, ACME).size).toBe(2); // refused, never half-applied

    const allowed = await bridge(engine, source, 10);
    await until(() => source.pending() === 0, "the truncate");
    allowed.stop();
    await allowed.done;
    expect(engine.rowsIn(TASKS, ACME).size).toBe(0);
  });
});

import type { SyncEvent } from "@syncmesh/kernel";

import { parsePartitionKey } from "@syncmesh/kernel";
import { all, any, evaluate, gt, isIn, lt, ne, not, rowIs } from "@syncmesh/policy";
import { describe, expect, test } from "bun:test";

import {
  EVERYTHING,
  interestKey,
  matchesInterest,
  narrows,
  predicateColumns,
} from "../interest.js";
import { CREATE, N1, PEER_A, hlcAt, key, procedure, row, seq, setup, table } from "./fixtures.js";

const JOBS = table("jobs");
const NOTES = table("notes");
const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures; ids and events are brands over these shapes */
/** One event carrying one change, so a test says exactly which change it is about. */
const eventOf = (change: SyncEvent["changes"][number], partition = ACME, n = 1): SyncEvent => ({
  v: 1,
  id: `${PEER_A}-${n}` as SyncEvent["id"],
  peerId: PEER_A,
  seqNum: seq(n),
  hlc: hlcAt(100 + n),
  procedure: CREATE,
  partition,
  changes: [change],
});

const inserted = (rank: number, done = false) =>
  eventOf({ kind: "insert", table: JOBS, key: N1, row: row({ rank, done }) });

/** The same event with no partition at all — a global write, which belongs to no instance. */
const unpinnedOf = (event: SyncEvent): SyncEvent => {
  const { partition, ...rest } = event;
  void partition;
  return rest as SyncEvent;
};
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

describe("the predicate grammar", () => {
  test("the comparisons agree with evaluate, and are false across kinds", () => {
    const ctx = { grant: { account: "", claims: {} }, roles: [], row: row({ rank: 5, name: "b" }) };
    expect(evaluate(gt("rank", 4), ctx)).toBe(true);
    expect(evaluate(gt("rank", 5), ctx)).toBe(false);
    expect(evaluate(lt("name", "c"), ctx)).toBe(true);
    expect(evaluate(ne("rank", 4), ctx)).toBe(true);
    expect(evaluate(ne("rank", 5), ctx)).toBe(false);
    expect(evaluate(isIn("rank", [1, 5, 9]), ctx)).toBe(true);
    expect(evaluate(isIn("rank", [1, 9]), ctx)).toBe(false);

    // a comparison across kinds, or against a column that is not there, is not satisfied —
    // never an accidental true, which is what a `not` would turn into a leak
    expect(evaluate(gt("rank", "5"), ctx)).toBe(false);
    expect(evaluate(gt("missing", 1), ctx)).toBe(false);
    expect(evaluate(gt("name", 1), ctx)).toBe(false);
  });

  test("predicateColumns finds every column a rule reads, through the combinators", () => {
    const rule = any(all(gt("rank", 3), not(rowIs({ done: true }))), isIn("owner", ["a"]));
    expect([...predicateColumns(rule)].sort()).toEqual(["done", "owner", "rank"]);
  });
});

describe("matchesInterest", () => {
  test("an empty interest wants everything", () => {
    expect(matchesInterest(EVERYTHING, inserted(1))).toBe(true);
  });

  test("partitions and tables narrow, and cost no predicate evaluation", () => {
    expect(matchesInterest({ partitions: [ACME] }, inserted(1))).toBe(true);
    expect(matchesInterest({ partitions: [GLOBEX] }, inserted(1))).toBe(false);
    expect(matchesInterest({ partitions: [ACME, GLOBEX] }, inserted(1))).toBe(true);
    expect(matchesInterest({ tables: [JOBS] }, inserted(1))).toBe(true);
    expect(matchesInterest({ tables: [NOTES] }, inserted(1))).toBe(false);
  });

  test("an event with no partition is not in any named instance", () => {
    const unpinned = unpinnedOf(inserted(1));
    expect(matchesInterest({ partitions: [ACME] }, unpinned)).toBe(false);
    expect(matchesInterest(EVERYTHING, unpinned)).toBe(true);
  });

  test("where: an insert must satisfy it", () => {
    const wanted = { where: gt("rank", 3) };
    expect(matchesInterest(wanted, inserted(5))).toBe(true);
    expect(matchesInterest(wanted, inserted(1))).toBe(false);
  });

  test("where: a row leaving the interest is still sent, so nobody is left holding a stale one", () => {
    const wanted = { where: rowIs({ done: false }) };
    // the patch satisfies it — plainly wanted
    expect(
      matchesInterest(
        wanted,
        eventOf({ kind: "update", table: JOBS, key: N1, patch: row({ done: false }) }),
      ),
    ).toBe(true);
    // the patch does NOT satisfy it, but touches a column the rule names: the device must see
    // this to learn the row left, or it keeps the last value it was told forever
    expect(
      matchesInterest(
        wanted,
        eventOf({ kind: "update", table: JOBS, key: N1, patch: row({ done: true }) }),
      ),
    ).toBe(true);
    // a patch touching nothing the rule mentions is genuinely uninteresting
    expect(
      matchesInterest(
        wanted,
        eventOf({ kind: "update", table: JOBS, key: N1, patch: row({ title: "x" }) }),
      ),
    ).toBe(false);
  });

  test("where: a delete always travels", () => {
    const wanted = { where: gt("rank", 1000) }; // nothing could satisfy it
    expect(matchesInterest(wanted, eventOf({ kind: "delete", table: JOBS, key: N1 }))).toBe(true);
  });

  test("an event travels when any one of its changes is wanted — there is no half an event", () => {
    const mixed: SyncEvent = {
      ...inserted(1),
      changes: [
        { kind: "insert", table: NOTES, key: key("n2"), row: row({ body: "x" }) },
        { kind: "insert", table: JOBS, key: N1, row: row({ rank: 9 }) },
      ],
    };
    expect(matchesInterest({ tables: [JOBS] }, mixed)).toBe(true);
    expect(matchesInterest({ tables: [table("other")] }, mixed)).toBe(false);
  });
});

describe("interestKey", () => {
  test("the same request is the same key, whatever order it was written in", () => {
    const a = { partitions: [ACME, GLOBEX], tables: [JOBS, NOTES], where: gt("rank", 1) };
    const b = { partitions: [GLOBEX, ACME], tables: [NOTES, JOBS], where: gt("rank", 1) };
    expect(interestKey(a)).toBe(interestKey(b));
    expect(interestKey(a)).not.toBe(interestKey({ ...a, where: gt("rank", 2) }));
    expect(interestKey(EVERYTHING)).toBe(interestKey({}));
    expect(interestKey({ tables: [JOBS] })).not.toBe(interestKey(EVERYTHING));
  });
});

describe("eventsSince", () => {
  test("filters at the sender: an unwanted event never becomes bytes", async () => {
    const a = setup(PEER_A, 100);
    const write = (rank: number, partition = ACME) =>
      a.engine.mutate(
        procedure("jobs.create"),
        (tx) => tx.insert(JOBS, key(`j${rank}`), row({ rank })),
        {
          partition,
        },
      );
    (await write(1)).unwrap();
    (await write(9)).unwrap();
    (await write(5, GLOBEX)).unwrap();

    const all = (await a.engine.eventsSince(new Map())).unwrap();
    expect(all).toHaveLength(3);
    expect((await a.engine.eventsSince(new Map(), { partitions: [ACME] })).unwrap()).toHaveLength(
      2,
    );
    expect((await a.engine.eventsSince(new Map(), { tables: [NOTES] })).unwrap()).toHaveLength(0);
    expect((await a.engine.eventsSince(new Map(), { where: gt("rank", 4) })).unwrap()).toHaveLength(
      2,
    );
    // and an interest is optional: no argument is the behaviour that existed before it
    expect((await a.engine.eventsSince(new Map())).unwrap()).toHaveLength(3);
  });
});

describe("whether an interest change can keep its cursor", () => {
  test("an unscoped cursor survives anything, because it already claims more", () => {
    expect(narrows({ partitions: [ACME] }, undefined)).toBe(true);
    expect(narrows({ partitions: [ACME] }, EVERYTHING)).toBe(true);
    expect(narrows(undefined, undefined)).toBe(true);
  });

  test("dropping to fewer partitions or tables narrows; adding one does not", () => {
    const both = { partitions: [ACME, GLOBEX] };
    expect(narrows({ partitions: [ACME] }, both)).toBe(true);
    expect(narrows(both, { partitions: [ACME] })).toBe(false);
    expect(narrows({ tables: [NOTES] }, { tables: [NOTES, JOBS] })).toBe(true);
    expect(narrows({ tables: [NOTES, JOBS] }, { tables: [NOTES] })).toBe(false);
  });

  test("asking for everything again is the widest move there is", () => {
    expect(narrows(undefined, { partitions: [ACME] })).toBe(false);
    expect(narrows(EVERYTHING, { partitions: [ACME] })).toBe(false);
  });

  test("every dimension has to narrow, not just one", () => {
    // fewer partitions but more tables is still a device asking to be told about more
    expect(
      narrows(
        { partitions: [ACME], tables: [NOTES, JOBS] },
        { partitions: [ACME, GLOBEX], tables: [NOTES] },
      ),
    ).toBe(false);
  });

  test("adding a predicate narrows; dropping one widens", () => {
    const filtered = { where: rowIs({ done: false }) };
    expect(narrows(filtered, {})).toBe(true);
    expect(narrows({}, filtered)).toBe(false);
    expect(narrows(filtered, filtered)).toBe(true);
  });

  test("a predicate this cannot compare answers no, and pays a re-join rather than a silent skip", () => {
    // `rank > 6` really is narrower than `rank > 5`, and reasoning that out is not worth being
    // wrong at: a wrong yes skips events for the life of the device, a wrong no costs a catch-up
    expect(narrows({ where: gt("rank", 6) }, { where: gt("rank", 5) })).toBe(false);
  });
});

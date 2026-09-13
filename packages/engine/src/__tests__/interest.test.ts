import type { SyncEvent } from "@syncmesh/kernel";

import { parsePartitionKey } from "@syncmesh/kernel";
import { evaluate, gt, isIn, lt, ne } from "@syncmesh/policy";
import { describe, expect, test } from "bun:test";

import { EVERYTHING, interestKey, matchesInterest, narrows } from "../interest.js";
import { CREATE, N1, PEER_A, hlcAt, row, seq, table } from "./fixtures.js";

const JOBS = table("jobs");
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
});

describe("matchesInterest", () => {
  test("an empty interest wants everything", () => {
    expect(matchesInterest(EVERYTHING, inserted(1))).toBe(true);
  });
});

describe("interestKey", () => {});

describe("eventsSince", () => {});

describe("whether an interest change can keep its cursor", () => {
  test("an unscoped cursor survives anything, because it already claims more", () => {
    expect(narrows({ partitions: [ACME] }, undefined)).toBe(true);
    expect(narrows({ partitions: [ACME] }, EVERYTHING)).toBe(true);
    expect(narrows(undefined, undefined)).toBe(true);
  });

  test("asking for everything again is the widest move there is", () => {
    expect(narrows(undefined, { partitions: [ACME] })).toBe(false);
    expect(narrows(EVERYTHING, { partitions: [ACME] })).toBe(false);
  });
});

describe("an interest is partitions and nothing finer (book ch. 3)", () => {
  test("two devices asking for the same instances are one subscription", () => {
    // order-insensitive: `[a, b]` and `[b, a]` are the same request, and a relay that treated
    // them as two would open two feeds over one answer
    expect(interestKey({ partitions: [ACME, GLOBEX] })).toBe(
      interestKey({ partitions: [GLOBEX, ACME] }),
    );
    expect(interestKey({ partitions: [ACME] })).not.toBe(interestKey({ partitions: [GLOBEX] }));
  });

  test("dropping an instance narrows; adding one does not", () => {
    expect(narrows({ partitions: [ACME] }, { partitions: [ACME, GLOBEX] })).toBe(true);
    expect(narrows({ partitions: [ACME, GLOBEX] }, { partitions: [ACME] })).toBe(false);
    // `undefined` is every instance the policy allows, so it is the widest value and never the
    // emptiest — asking for it back is widening
    expect(narrows(undefined, { partitions: [ACME] })).toBe(false);
  });

  test("an event belongs to one instance, and that is the whole of the filter", () => {
    expect(matchesInterest({ partitions: [ACME] }, inserted(1))).toBe(true);
    expect(matchesInterest({ partitions: [GLOBEX] }, inserted(1))).toBe(false);
    // a global write belongs to no instance, so an interest that names any does not want it
    expect(matchesInterest({ partitions: [ACME] }, unpinnedOf(inserted(1)))).toBe(false);
    expect(matchesInterest(EVERYTHING, unpinnedOf(inserted(1)))).toBe(true);
  });
});

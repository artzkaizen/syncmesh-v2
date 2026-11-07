import { describe, expect, test } from "bun:test";

import type { Holding } from "../invariant.js";
import type { Fact } from "../ledger.js";

import { checkDigests, checkHeld } from "../invariant.js";
import { createLedger } from "../ledger.js";

/** One acknowledged write by `device`, authored as `author` at `seqNum`. */
const authored = (device: string, author: string, seqNum: number) =>
  ({
    kind: "authored",
    device,
    table: "note",
    key: `n${seqNum}`,
    op: "insert",
    values: {},
    stamp: "",
    eventId: `${author}-${seqNum}`,
    author,
    seqNum,
  }) as const;

const holding = (
  device: string,
  ids: readonly string[],
  cursors: Readonly<Record<string, number>> = {},
  digests: Readonly<Record<string, string>> = { note: "1" },
): Holding => ({
  device,
  ids: new Set(ids),
  cursors: new Map(Object.entries(cursors)),
  digests: new Map(Object.entries(digests)),
});

/** A ledger with two writes by `a` (author `pa`), plus whatever else a case adds. */
const ledgerWith = (...extra: readonly Fact[]) => {
  const ledger = createLedger(0);
  ledger.write(authored("a", "pa", 1));
  ledger.write(authored("a", "pa", 2));
  for (const fact of extra) ledger.write(fact);
  return ledger.entries();
};

describe("checkHeld", () => {
  test("every event in every log is held, and nothing is a violation", () => {
    const report = checkHeld(ledgerWith(), [
      holding("a", ["pa-1", "pa-2"], { pa: 2 }),
      holding("b", ["pa-1", "pa-2"], { pa: 2 }),
    ]);
    expect(report.checked).toBe(4);
    expect(report.violations).toEqual([]);
  });

  test("an event a device lacks, with no refusal, is a violation naming it", () => {
    const report = checkHeld(ledgerWith(), [
      holding("a", ["pa-1", "pa-2"], { pa: 2 }),
      holding("b", ["pa-1"], { pa: 1 }),
    ]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.device).toBe("b");
    expect(report.violations[0]?.detail).toContain("pa-2");
  });

  test("a compacted event counts as held when the floor and the cursor both cover it", () => {
    const entries = ledgerWith({ kind: "compacted", device: "b", removed: 1, floor: { pa: 1 } });
    const report = checkHeld(entries, [
      holding("a", ["pa-1", "pa-2"], { pa: 2 }),
      holding("b", ["pa-2"], { pa: 2 }),
    ]);
    expect(report.covered).toBe(1);
    expect(report.violations).toEqual([]);
  });

  test("a cursor past an event the log lacks, with no floor under it, is a violation", () => {
    const report = checkHeld(ledgerWith(), [
      holding("a", ["pa-1", "pa-2"], { pa: 2 }),
      holding("b", ["pa-2"], { pa: 2 }),
    ]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.detail).toContain("claims");
  });

  test("adopted state covers what it claims, like a floor does", () => {
    const entries = ledgerWith({
      kind: "covered",
      device: "b",
      source: "snapshot",
      cursors: { pa: 2 },
    });
    const report = checkHeld(entries, [
      holding("a", ["pa-1", "pa-2"], { pa: 2 }),
      holding("b", [], { pa: 2 }),
    ]);
    expect(report.covered).toBe(2);
    expect(report.violations).toEqual([]);
  });

  test("a device told by a typed refusal is refused, not violated", () => {
    const entries = ledgerWith({
      kind: "refused",
      device: "b",
      transport: "relay",
      code: "retention",
      message: "below the floor",
    });
    const report = checkHeld(entries, [
      holding("a", ["pa-1", "pa-2"], { pa: 2 }),
      holding("b", ["pa-1"], { pa: 1 }),
    ]);
    expect(report.violations).toEqual([]);
    expect(report.refused).toEqual([
      { device: "b", eventId: "pa-2", refusal: "relay retention: below the floor" },
    ]);
  });

  test("a refusal does not excuse a cursor that claims an event the log lacks", () => {
    const entries = ledgerWith({
      kind: "refused",
      device: "b",
      transport: "relay",
      code: "retention",
      message: "below the floor",
    });
    const report = checkHeld(entries, [holding("b", ["pa-1"], { pa: 2 })]);
    expect(report.refused).toEqual([]);
    expect(report.violations).toHaveLength(1);
  });
});

describe("checkDigests", () => {
  test("agreeing digests are no violation", () => {
    expect(checkDigests([holding("a", []), holding("b", []), holding("c", [])])).toEqual([]);
  });

  test("the device off the majority is named, per table", () => {
    const violations = checkDigests([
      holding("a", []),
      holding("b", []),
      holding("c", [], {}, { note: "2" }),
    ]);
    expect(violations.map((violation) => violation.device)).toEqual(["c"]);
    expect(violations[0]?.detail).toContain("table note");
  });

  test("a device known not to have converged is left out of the comparison", () => {
    const violations = checkDigests(
      [holding("a", []), holding("b", []), holding("c", [], {}, { note: "2" })],
      new Set(["c"]),
    );
    expect(violations).toEqual([]);
  });
});

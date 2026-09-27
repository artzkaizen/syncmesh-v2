import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { DocChange, LineageId } from "../doc.js";

import { applyChange, mergeRecord } from "../apply.js";
import {
  lineageOf,
  lineageRule,
  parseActionId,
  parseAdapterId,
  parseLineageId,
  withDocColumns,
} from "../doc.js";
import { getRecord, isVisible } from "../index.js";
import { compareStamp } from "../stamp.js";
import { emptyState } from "../state.js";
import { strategies } from "../strategy.js";
import {
  applyAll,
  column,
  insert,
  MERGE,
  N1,
  NOTES,
  PEER_A,
  PEER_B,
  PEER_C,
  plainState,
  remove,
  stamp,
  type Stamped,
} from "./fixtures.js";

const CONTENT = column("content");
const LORO = parseAdapterId("loro@1").unwrap();
const lineage = (fill: string): LineageId => parseLineageId(fill.repeat(32)).unwrap();

const doc = (extra: Partial<DocChange> = {}): DocChange => ({
  kind: "doc",
  table: NOTES,
  key: N1,
  column: CONTENT,
  adapter: LORO,
  update: { bytes: Uint8Array.of(1, 2, 3) },
  ...extra,
});

const genesis = (l: LineageId, at: Stamped["stamp"]): Stamped => ({
  change: doc({ lineage: l, genesis: true }),
  stamp: at,
});

const lineageAfter = (changes: readonly Stamped[]) =>
  lineageOf(getRecord(applyAll(changes), NOTES, N1), CONTENT);

describe("doc ids", () => {
  test("a 16-byte id is 32 lowercase hex characters, and nothing else", () => {
    expect(parseLineageId("ab".repeat(16)).isOk()).toBe(true);
    expect(parseActionId("0".repeat(32)).isOk()).toBe(true);
    for (const bad of ["AB".repeat(16), "ab".repeat(15), "ab".repeat(17), "zz".repeat(16)])
      expect(parseLineageId(bad).isErr()).toBe(true);
  });

  test("an adapter id names its major", () => {
    for (const good of ["loro@1", "automerge@3", "y-js@12"])
      expect(parseAdapterId(good).isOk()).toBe(true);
    for (const bad of ["loro", "loro@0", "Loro@1", "loro@1.2", "@1", "loro@"])
      expect(parseAdapterId(bad).isErr()).toBe(true);
  });
});

describe("applyChange — a doc change", () => {
  test("an ordinary update leaves the state exactly as it was", () => {
    const state = applyAll([insert({ title: "t" }, stamp(1, 0, PEER_A))]);
    expect(applyChange(state, doc(), stamp(2, 0, PEER_B))).toBe(state);
    expect(applyChange(state, doc({ lineage: lineage("a") }), stamp(2, 0, PEER_B))).toBe(state);
  });

  test("a genesis sets only the lineage cell, with the genesis's stamp", () => {
    const at = stamp(2, 0, PEER_B);
    const state = applyAll([
      insert({ title: "t" }, stamp(1, 0, PEER_A)),
      genesis(lineage("a"), at),
    ]);
    const record = getRecord(state, NOTES, N1);
    expect(record?.cells.get(CONTENT)).toEqual({ value: lineage("a"), stamp: at });
    expect(record?.writeStamp).toEqual(stamp(1, 0, PEER_A));
  });

  test("a genesis never resurrects a deleted row, nor outlives a later delete", () => {
    const state = applyAll([
      insert({ title: "t" }, stamp(1, 0, PEER_A)),
      remove(stamp(2, 0, PEER_A)),
      genesis(lineage("a"), stamp(3, 0, PEER_B)),
    ]);
    const record = getRecord(state, NOTES, N1);
    expect(record !== undefined && isVisible(record)).toBe(false);
  });

  test("a genesis before the row's insert joins it when the insert lands, in either order", () => {
    const g = genesis(lineage("a"), stamp(1, 0, PEER_B));
    const i = insert({ title: "t" }, stamp(2, 0, PEER_A));
    expect(plainState(applyAll([g, i]))).toEqual(plainState(applyAll([i, g])));
    expect(lineageAfter([g, i])).toBe(lineage("a"));
  });

  test("the root lineage is the absent cell, and a foreign value reads as the root", () => {
    expect(lineageAfter([insert({ title: "t" }, stamp(1, 0, PEER_A))])).toBeUndefined();
    const foreign = applyAll([insert({ content: "not an id" }, stamp(1, 0, PEER_A))]);
    expect(lineageOf(getRecord(foreign, NOTES, N1), CONTENT)).toBeUndefined();
  });
});

describe("lineageRule — concurrent geneses", () => {
  test("the rule is last-writer-wins today (RFC-0023 §16.1 is the owner's to change)", () => {
    expect(lineageRule).toBe(strategies.lww);
  });

  test("any delivery order of any geneses lands on the one with the greatest stamp", () => {
    const peers = [PEER_A, PEER_B, PEER_C];
    // distinct stamps: one author's clock never repeats, and one event starts one lineage per
    // document (the ladder refuses a second), so two geneses never share a stamp in a real log
    const arbitrary = fc.uniqueArray(
      fc.record({
        ms: fc.nat({ max: 5 }),
        peer: fc.nat({ max: 2 }),
        fill: fc.nat({ max: 15 }),
        order: fc.nat(),
      }),
      { minLength: 1, maxLength: 6, selector: ({ ms, peer }) => `${ms}/${peer}` },
    );
    fc.assert(
      fc.property(arbitrary, (specs) => {
        const geneses = specs.map(({ ms, peer, fill }) =>
          genesis(lineage(fill.toString(16)), stamp(ms, 0, peers[peer] ?? PEER_A)),
        );
        const shuffled = specs
          .map((spec, i) => [spec.order, geneses[i]] as const)
          .sort(([x], [y]) => x - y)
          .flatMap(([, g]) => (g === undefined ? [] : [g]));
        const forward = plainState(applyAll(geneses));
        expect(plainState(applyAll(shuffled))).toEqual(forward);
        expect(plainState(applyAll([...geneses, ...geneses]))).toEqual(forward);
        const winner = geneses.reduce((best, g) =>
          compareStamp(g.stamp, best.stamp) > 0 ? g : best,
        );
        expect(lineageAfter(geneses)).toBe(
          winner.change.kind === "doc" ? winner.change.lineage : undefined,
        );
      }),
      { numRuns: 300, seed: 23 },
    );
  });

  test("a record joined with doc columns declared takes the lineage rule, whatever `merge` said", () => {
    const spec = withDocColumns(MERGE, new Map([[NOTES, new Map([[CONTENT, LORO]])]]));
    expect(spec.get(NOTES)?.get(CONTENT)).toBe("lineage");
    expect(spec.get(NOTES)?.get(column("likes"))).toBe("max");
    const older = {
      cells: new Map([[CONTENT, { value: lineage("f"), stamp: stamp(1, 0, PEER_A) }]]),
    };
    const newer = {
      cells: new Map([[CONTENT, { value: lineage("0"), stamp: stamp(2, 0, PEER_B) }]]),
    };
    const joined = mergeRecord(
      mergeRecord(emptyState(), NOTES, N1, newer, spec),
      NOTES,
      N1,
      older,
      spec,
    );
    expect(lineageOf(getRecord(joined, NOTES, N1), CONTENT)).toBe(lineage("0"));
  });
});

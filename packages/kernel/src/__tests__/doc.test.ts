import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { DocChange, LineageId } from "../doc.js";

import { applyChange, mergeRecord } from "../apply.js";
import {
  GENESIS_RULE,
  cellGeneses,
  docLineage,
  parseActionId,
  parseAdapterId,
  parseLineageCells,
  parseLineageId,
  withDocColumns,
} from "../doc.js";
import { getRecord, isVisible } from "../index.js";
import { emptyState } from "../state.js";
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

const genesis = (l: LineageId, at: Stamped["stamp"], parent?: LineageId): Stamped => ({
  change: doc({ lineage: l, genesis: true, ...(parent !== undefined && { parent }) }),
  stamp: at,
});

const lineageAfter = (changes: readonly Stamped[]) =>
  docLineage(getRecord(applyAll(changes), NOTES, N1), CONTENT);

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

  test("a genesis adds only itself to the lineage cell: its lineage, its parent, its stamp", () => {
    const at = stamp(2, 0, PEER_B);
    const state = applyAll([
      insert({ title: "t" }, stamp(1, 0, PEER_A)),
      genesis(lineage("a"), at),
      genesis(lineage("b"), stamp(3, 0, PEER_A), lineage("a")),
    ]);
    const record = getRecord(state, NOTES, N1);
    expect(record?.cells.get(CONTENT)?.value).toEqual([
      GENESIS_RULE,
      {
        [lineage("a")]: [null, 2, 0, PEER_B],
        [lineage("b")]: [lineage("a"), 3, 0, PEER_A],
      },
    ]);
    expect(record?.cells.get(CONTENT)?.stamp).toEqual(stamp(3, 0, PEER_A));
    expect(cellGeneses(record?.cells.get(CONTENT)?.value)).toEqual([
      { lineage: lineage("a"), parent: undefined, stamp: at },
      { lineage: lineage("b"), parent: lineage("a"), stamp: stamp(3, 0, PEER_A) },
    ]);
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
    expect(docLineage(getRecord(foreign, NOTES, N1), CONTENT)).toBeUndefined();
  });
});

/**
 * The rule as RFC-0023 §16.1 states it, written out the slow way: among the geneses that replaced
 * one lineage the smallest stamp wins, and the document follows the winners down from the root.
 */
const reference = (geneses: readonly Stamped[]): LineageId | undefined => {
  const named = geneses.flatMap(({ change, stamp: at }) =>
    change.kind === "doc" && change.lineage !== undefined
      ? [{ lineage: change.lineage, parent: change.parent, at }]
      : [],
  );
  let current: LineageId | undefined;
  for (let depth = 0; depth <= named.length; depth += 1) {
    const children = named
      .filter((g) => g.parent === current)
      .sort((x, y) => compareStampOrLineage(x, y));
    const first = children[0];
    if (first === undefined) return current;
    current = first.lineage;
  }
  return current;
};

const compareStampOrLineage = (
  x: { at: Stamped["stamp"]; lineage: LineageId },
  y: { at: Stamped["stamp"]; lineage: LineageId },
) => {
  const ms = x.at.hlc[0].epochMilliseconds - y.at.hlc[0].epochMilliseconds;
  if (ms !== 0) return ms;
  if (x.at.peer !== y.at.peer) return x.at.peer < y.at.peer ? -1 : 1;
  return x.lineage < y.lineage ? -1 : 1;
};

describe("lineage — the first genesis wins, as a tree (RFC-0023 §16.1)", () => {
  test("two replaces of one lineage: the first wins, and a late one discards nothing", () => {
    const first = genesis(lineage("a"), stamp(1, 0, PEER_A));
    const late = genesis(lineage("b"), stamp(5, 0, PEER_B));
    expect(lineageAfter([first, late])).toBe(lineage("a"));
    expect(lineageAfter([late, first])).toBe(lineage("a"));
  });

  test("a replace on top of the winner — a restore, a reset, an undo — wins, however late", () => {
    const imported = genesis(lineage("a"), stamp(1, 0, PEER_A));
    const restored = genesis(lineage("b"), stamp(9, 0, PEER_B), lineage("a"));
    const reset = genesis(lineage("c"), stamp(12, 0, PEER_A), lineage("b"));
    expect(lineageAfter([imported, restored])).toBe(lineage("b"));
    expect(lineageAfter([reset, imported, restored])).toBe(lineage("c"));
  });

  test("of two replaces of the winner, the first wins and the walk follows it", () => {
    const base = genesis(lineage("a"), stamp(1, 0, PEER_A));
    const mine = genesis(lineage("b"), stamp(4, 0, PEER_A), lineage("a"));
    const theirs = genesis(lineage("c"), stamp(3, 0, PEER_B), lineage("a"));
    const onMine = genesis(lineage("d"), stamp(2, 0, PEER_C), lineage("b"));
    expect(lineageAfter([base, mine, theirs, onMine])).toBe(lineage("c"));
  });

  test("a genesis whose parent has not arrived waits off the walk, and joins it when it lands", () => {
    const parent = genesis(lineage("a"), stamp(1, 0, PEER_A));
    const child = genesis(lineage("b"), stamp(2, 0, PEER_B), lineage("a"));
    expect(lineageAfter([child])).toBeUndefined();
    expect(lineageAfter([child, parent])).toBe(lineage("b"));
  });

  test("a cycle that never reaches the root is never walked into", () => {
    const one = genesis(lineage("a"), stamp(1, 0, PEER_A), lineage("b"));
    const two = genesis(lineage("b"), stamp(2, 0, PEER_A), lineage("a"));
    const self = genesis(lineage("c"), stamp(3, 0, PEER_A), lineage("c"));
    expect(lineageAfter([one, two, self])).toBeUndefined();
  });

  test("a cell that is not the set's shape reads entry by entry, the same on every peer", () => {
    const mangled = {
      [lineage("a")]: [null, 1, 0, PEER_A],
      [lineage("b")]: ["not an id", 1, 0, PEER_A],
      [lineage("c")]: [null, -1, 0, PEER_A],
      "not a lineage": [null, 1, 0, PEER_A],
    };
    expect(cellGeneses([GENESIS_RULE, mangled]).map((g) => g.lineage)).toEqual([lineage("a")]);
    expect(cellGeneses(lineage("a"))).toEqual([]);
  });

  test("any tree, in any order, in any batches, repeated: one cell, and the reference winner", () => {
    const peers = [PEER_A, PEER_B, PEER_C];
    // each genesis may replace the root or any genesis before it; stamps are distinct per author
    // as a real log's are, and one event starts one lineage per document
    const arbitrary = fc
      .uniqueArray(fc.record({ ms: fc.nat({ max: 6 }), peer: fc.nat({ max: 2 }) }), {
        minLength: 1,
        maxLength: 7,
        selector: ({ ms, peer }) => `${ms}/${peer}`,
      })
      .chain((stamps) =>
        fc.tuple(
          fc.constant(stamps),
          fc.array(fc.nat(), { minLength: stamps.length, maxLength: stamps.length }),
          fc.array(fc.nat(), { minLength: stamps.length, maxLength: stamps.length }),
          fc.nat({ max: stamps.length }),
        ),
      );
    fc.assert(
      fc.property(arbitrary, ([stamps, parents, order, cut]) => {
        const geneses = stamps.map(({ ms, peer }, i) => {
          const parentAt = (parents[i] ?? 0) % (i + 1);
          const parent = parentAt === i ? undefined : lineage(parentAt.toString(16));
          return genesis(lineage(i.toString(16)), stamp(ms, 0, peers[peer] ?? PEER_A), parent);
        });
        const shuffled = geneses
          .map((g, i) => [order[i] ?? 0, g] as const)
          .sort(([x], [y]) => x - y)
          .map(([, g]) => g);
        const forward = plainState(applyAll(geneses));
        expect(plainState(applyAll(shuffled))).toEqual(forward);
        expect(plainState(applyAll([...shuffled, ...geneses]))).toEqual(forward);
        // two peers that each folded half, then exchanged records, hold the same cell
        const spec = new Map([[NOTES, new Map([[CONTENT, "lineage" as const]])]]);
        const left = getRecord(applyAll(shuffled.slice(0, cut)), NOTES, N1);
        const right = getRecord(applyAll(shuffled.slice(cut)), NOTES, N1);
        const joined = [left, right].reduce(
          (state, record) =>
            record === undefined ? state : mergeRecord(state, NOTES, N1, record, spec),
          emptyState(),
        );
        expect(docLineage(getRecord(joined, NOTES, N1), CONTENT)).toBe(lineageAfter(geneses));
        expect(lineageAfter(shuffled)).toBe(reference(geneses));
      }),
      { numRuns: 500, seed: 23 },
    );
  });

  test("a record joined with doc columns declared takes the lineage rule, whatever `merge` said", () => {
    const spec = withDocColumns(MERGE, new Map([[NOTES, new Map([[CONTENT, LORO]])]]));
    expect(spec.get(NOTES)?.get(CONTENT)).toBe("lineage");
    expect(spec.get(NOTES)?.get(column("likes"))).toBe("max");
    const cellOf = (l: LineageId, at: Stamped["stamp"]) =>
      getRecord(applyAll([genesis(l, at)]), NOTES, N1) ?? { cells: new Map() };
    const older = cellOf(lineage("f"), stamp(1, 0, PEER_A));
    const newer = cellOf(lineage("0"), stamp(2, 0, PEER_B));
    const joined = mergeRecord(
      mergeRecord(emptyState(), NOTES, N1, newer, spec),
      NOTES,
      N1,
      older,
      spec,
    );
    expect(docLineage(getRecord(joined, NOTES, N1), CONTENT)).toBe(lineage("f"));
  });
});

describe("a lineage cell kept outside events carries its rule's version (RFC-0023 §16.1)", () => {
  const DOCS = new Map([[NOTES, new Map([[CONTENT, LORO]])]]);
  const held = getRecord(applyAll([genesis(lineage("a"), stamp(1, 0, PEER_A))]), NOTES, N1);
  const withCell = (value: Parameters<typeof cellGeneses>[0] & {}) => ({
    table: NOTES,
    key: N1,
    record: { cells: new Map([[CONTENT, { value, stamp: stamp(1, 0, PEER_A) }]]) },
  });
  const geneses = { [lineage("a")]: [null, 1, 0, PEER_A] };

  test("a cell this rule wrote passes, and so does a row with no cell", () => {
    expect(
      held === undefined
        ? undefined
        : parseLineageCells([{ table: NOTES, key: N1, record: held }], DOCS).isOk(),
    ).toBe(true);
    const plain = getRecord(applyAll([insert({ title: "t" }, stamp(1, 0, PEER_A))]), NOTES, N1);
    expect(
      plain === undefined
        ? undefined
        : parseLineageCells([{ table: NOTES, key: N1, record: plain }], DOCS).isOk(),
    ).toBe(true);
  });

  test("an untagged cell, the LWW rule's id or another version is refused, never read as the root", () => {
    for (const [value, version] of [
      [geneses, null],
      [lineage("a"), null],
      [[2, geneses], 2],
    ] as const) {
      const refused = parseLineageCells([withCell(value)], DOCS);
      expect(refused.isErr() && refused.error.version).toBe(version);
      expect(cellGeneses(value)).toEqual([]);
    }
  });

  test("a column that is not a doc column is not checked", () => {
    expect(parseLineageCells([withCell(geneses)], new Map()).isOk()).toBe(true);
  });
});

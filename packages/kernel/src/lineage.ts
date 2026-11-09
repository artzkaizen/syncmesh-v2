import { Temporal } from "@syncmesh/temporal";

import type { TableName } from "./change.js";
import type { DocColumns, LineageId } from "./doc.js";
import type { Genesis, SettledLineage } from "./lineage-cell.js";
import type { Cell, CellValue, ColumnName, RowRecord } from "./record.js";
import type { MergeSpec, Strategy } from "./strategy.js";

import { firstGenesis, laterAnchor, passed, readLineageCell, writeCell } from "./lineage-cell.js";
import { compareStamp } from "./stamp.js";
import { strategies } from "./strategy.js";

/**
 * The lineage rule (RFC-0023 §5.3, §16.1; gaps U21, U39): the walk that picks a document's winner,
 * the anchor that settles it, and the cell's join.
 *
 * @module
 */

/** The walk, in order: each winner's winning child, from the anchor (or the root) to the end. */
function walkPath(
  geneses: readonly Genesis[],
  settled: SettledLineage | undefined,
): readonly Genesis[] {
  const children = new Map<LineageId | undefined, Genesis>();
  for (const genesis of geneses) {
    if (passed(genesis, settled)) continue;
    const best = children.get(genesis.parent);
    if (best === undefined || firstGenesis(genesis, best) < 0)
      children.set(genesis.parent, genesis);
  }
  const path: Genesis[] = [];
  const walked = new Set<LineageId>();
  let at = settled?.lineage;
  for (let next = children.get(at); next !== undefined; next = children.get(at)) {
    // one parent per genesis keeps the walk a path, but a peer can still name a cycle off the root
    if (walked.has(next.lineage)) break;
    walked.add(next.lineage);
    path.push(next);
    at = next.lineage;
  }
  return path;
}

/**
 * The lineage a set of geneses settles on — **the one place the lineage rule lives** (RFC-0023
 * §5.3, decided in §16.1 on 2026-11-08: first genesis wins).
 *
 * The geneses form a tree: each names the lineage it replaced, and the root lineage is the tree's
 * root. Among the geneses that replaced one lineage, the one with the **smallest** stamp wins, so
 * a late `replace()` of a version a colleague already replaced loses instead of discarding their
 * work. The walk starts at the root, steps to the current winner's winning child, and stops at a
 * winner nothing replaced. A replace made on top of the winner — a restore, a reset to a template,
 * the undo of a replace — is that winner's child, so it still wins.
 *
 * With a `settled` anchor (gaps U21) the walk starts there instead, and a genesis it has passed —
 * stamped at or below it — is off the walk, wherever it hangs.
 *
 * A function of the set alone: the same geneses give the same lineage in any arrival order or
 * batching. A genesis whose parent is not held yet hangs off nothing the walk reaches until the
 * parent arrives, which is how out-of-order delivery resolves without parking anything.
 */
export function winningLineage(
  geneses: readonly Genesis[],
  settled?: SettledLineage,
): LineageId | undefined {
  return walkPath(geneses, settled).at(-1)?.lineage ?? settled?.lineage;
}

/**
 * Where a genesis written now may settle the walk of `value` (gaps U21): the deepest lineage on
 * it whose genesis is stamped at or before `cutoff`, or `undefined` when none is deeper than the
 * anchor the cell already holds. The walk stops at the first genesis newer than `cutoff`, so a
 * lineage past one never settles ahead of it.
 *
 * `cutoff` is the writer's promise that no genesis stamped before it can still arrive from a peer
 * it counts. One that does anyway — from a device offline for longer — is off the walk on every
 * peer alike once the anchor lands, which is how RFC-0015 §2a already treats a forgotten peer.
 */
export function settleWalk(
  value: CellValue | undefined,
  cutoff: Temporal.Instant,
): SettledLineage | undefined {
  const { geneses, settled } = readLineageCell(value);
  let deepest: Genesis | undefined;
  for (const genesis of walkPath(geneses, settled)) {
    if (Temporal.Instant.compare(genesis.stamp.hlc[0], cutoff) > 0) break;
    deepest = genesis;
  }
  return deepest === undefined ? undefined : { lineage: deepest.lineage, stamp: deepest.stamp };
}

/**
 * How two lineage cells join: the union of their geneses, by lineage id, under the later of their
 * anchors, with every genesis that anchor passed dropped (see {@link writeCell}). A lattice join —
 * commutative, associative, idempotent — so peers folding the same geneses in any order hold the
 * same cell, and the winner is read from it by {@link winningLineage}, never stored. Dropping is a
 * property of each genesis's stamp against the one anchor every peer converges on, so a cell
 * trimmed here and a cell not yet trimmed there join to the same value. Two entries for one
 * lineage only come from an author who signed two events at one sequence (equivocation, gaps
 * U39); the later by {@link firstGenesis} is kept, which an anchor drops no sooner than the
 * earlier, so the cell — and the winner read from it — is the same in every order the two copies
 * and any anchor meet in (RFC-0023 §16.1, rule 3). The cell's stamp is the later of the two.
 */
export const lineageRule: Strategy = (incoming, current) => {
  const held = readLineageCell(current?.value);
  const arriving = readLineageCell(incoming.value);
  const stamp =
    current === undefined || compareStamp(incoming.stamp, current.stamp) > 0
      ? incoming.stamp
      : current.stamp;
  const value = writeCell(
    [...held.geneses, ...arriving.geneses],
    laterAnchor(held.settled, arriving.settled),
  );
  return { value, stamp };
};

/**
 * The rules a {@link MergeSpec} can name: the three row rules, and the lineage rule the kernel
 * puts on every doc column itself. Never a rule an app declares: a doc column is merged by an
 * adapter, and this is only the rule for which history it merges.
 */
export type CellRule = keyof typeof cellRules;

export const cellRules = { ...strategies, lineage: lineageRule } satisfies Readonly<
  Record<string, Strategy>
>;

/**
 * The merge spec with every doc column's cell under {@link lineageRule}. What every join of a
 * record — a fold, a repair, a snapshot page — must be given, so a doc column's cell is never
 * joined by a row rule that happens to be the default.
 */
export function withDocColumns(merge: MergeSpec | undefined, docs: DocColumns): MergeSpec {
  const joined = new Map<TableName, ReadonlyMap<ColumnName, CellRule>>(merge ?? []);
  for (const [table, columns] of docs) {
    const rules = new Map<ColumnName, CellRule>(joined.get(table) ?? []);
    for (const column of columns.keys()) rules.set(column, "lineage");
    joined.set(table, rules);
  }
  return joined;
}

/**
 * The lineage cell a genesis writes: the one genesis, stamped with it, and the anchor it settles
 * the walk at when it carries one (`[3, { genesis }, anchor]`, gaps U21).
 */
export const lineageCell = (genesis: Genesis, settles?: SettledLineage): Cell => ({
  value: writeCell([genesis], settles),
  stamp: genesis.stamp,
});

/**
 * The lineage a document is on: the winner of the geneses its cell holds, walked from its anchor
 * (see {@link winningLineage}), or `undefined` for the root lineage.
 */
export const docLineage = (
  record: RowRecord | undefined,
  column: ColumnName,
): LineageId | undefined => {
  const { geneses, settled } = readLineageCell(record?.cells.get(column)?.value);
  return winningLineage(geneses, settled);
};

import type {
  CellRule,
  CellValue,
  Change,
  ColumnName,
  MergeSpec,
  Procedure,
  Row,
  RowKey,
  RowRecord,
  Stamp,
  State,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";

import {
  compareStamp,
  compareValue,
  counterDelta,
  getRecord,
  isVisible,
  readRow,
  stampOf,
} from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { Engine, MutateOptions } from "./engine.js";
import type { Tx } from "./tx.js";

import { CannotRevert } from "./errors.js";
import { docWriteOf } from "./tx.js";

const revertProcedure = (): Procedure => {
  // SAFETY: the one procedure the engine itself authors; naming rules arrive with the client
  return "revert" as Procedure;
};

const REVERT = revertProcedure();

export interface Undo {
  readonly event: SyncEvent;
  /** Every row the write touched, as it read just before the write: what a revert restores. */
  readonly before: readonly RowBefore[];
}

/** One row as it read before a write; `row` absent when it was not there to read. */
export interface RowBefore {
  readonly table: TableName;
  readonly key: RowKey;
  readonly row?: Row;
}

/**
 * Something a revert did not simply take back (RFC-0023 §9). `superseded`: someone changed the
 * cell — or, with no `column`, the whole row — after the write, so their change stands and the
 * revert left it alone. `document`: a document update, which only its adapter can compensate and
 * which this revert does not touch. `merge`: the column's rule keeps what the write joined in — a
 * `max` it raised, a `min` it lowered, a `counter` written as totals rather than an increment — so
 * writing the old value back would change nothing and the revert does not pretend to. `overridden`: a cell someone wrote after the insert this revert takes back, deleted
 * with the row.
 */
export interface Skipped {
  readonly table: TableName;
  readonly key: RowKey;
  readonly column?: ColumnName;
  readonly reason: "superseded" | "document" | "merge" | "overridden";
}

/** What a revert wrote, if anything was left to write, and what it left alone. */
export interface Reverted {
  readonly event?: SyncEvent;
  readonly skipped: readonly Skipped[];
}

const rowId = (table: TableName, key: RowKey) => `${table}\u0000${key}`;

/** The rows `changes` touch, read from `state` before they apply: a revert's raw material. */
export function rowsBefore(state: State, changes: readonly Change[]): readonly RowBefore[] {
  const seen = new Map<string, RowBefore>();
  for (const change of changes) {
    // a document update moves no row value (its update is the log's), and an unknown change is
    // never authored here, so neither has a row image to keep (D22-A)
    if (change.kind === "doc" || change.kind === "unknown") continue;
    const id = rowId(change.table, change.key);
    if (seen.has(id)) continue;
    const { table, key } = change;
    const row = readRow(state, table, key);
    seen.set(id, row === undefined ? { table, key } : { table, key, row });
  }
  return [...seen.values()];
}

/** Per row: whether the write deleted it, and each column it wrote with every value it wrote there. */
function writtenRows(changes: readonly Change[]) {
  const rows = new Map<string, Written>();
  for (const change of changes) {
    if (change.kind === "doc" || change.kind === "unknown") continue;
    const id = rowId(change.table, change.key);
    const entry = rows.get(id) ?? { deleted: false, columns: new Map<ColumnName, CellValue[]>() };
    if (change.kind === "delete") entry.deleted = true;
    else
      for (const [c, value] of change.kind === "insert" ? change.row : change.patch)
        entry.columns.set(c, [...(entry.columns.get(c) ?? []), value]);
    rows.set(id, entry);
  }
  return rows;
}

/** One row's share of a write: whether it deleted the row, and what it wrote to each column. */
interface Written {
  deleted: boolean;
  readonly columns: Map<ColumnName, readonly CellValue[]>;
}

const holds = (stamp: Stamp | undefined, mine: Stamp) =>
  stamp !== undefined && compareStamp(stamp, mine) === 0;

/** What a revert writes, and what it leaves as it found it. */
export interface Compensation {
  readonly changes: readonly Change[];
  readonly skipped: readonly Skipped[];
}

/** One table's column rules; absent is `lww` throughout. */
type TableRules = ReadonlyMap<ColumnName, CellRule> | undefined;

/**
 * What takes one cell that still holds the write back to `old`, by the column's rule: the old
 * value for `lww`; for `counter`, the increment that cancels the write's own (`{"+": -n}`), since
 * a normal-form value joins by per-author max and would change nothing; for `max`/`min`, the old
 * value only when the rule lets it win. `undefined` when the rule keeps what the write joined in.
 */
function restoreCell(
  rule: CellRule,
  current: CellValue,
  old: CellValue,
  wrote: readonly CellValue[],
): CellValue | undefined {
  if (rule === "counter") {
    let total = 0;
    for (const value of wrote) {
      const delta = counterDelta(value);
      if (delta === undefined) return undefined;
      total += delta;
    }
    return { "+": -total };
  }
  if (rule === "max" && compareValue(old, current) < 0) return undefined;
  if (rule === "min" && compareValue(old, current) > 0) return undefined;
  return old;
}

/** Where a row's compensation goes: what it writes, and what it reports. */
interface Out {
  readonly changes: Change[];
  readonly skipped: Skipped[];
}

/**
 * A row the write brought into being: deleted, with any cell a colleague wrote since reported
 * `overridden`, or — gone already — reported `superseded` with nothing written.
 */
function uninsert(
  mine: Stamp,
  table: TableName,
  key: RowKey,
  now: RowRecord | undefined,
  out: Out,
) {
  if (now === undefined || !isVisible(now)) {
    out.skipped.push({ table, key, reason: "superseded" });
    return;
  }
  out.changes.push({ kind: "delete", table, key });
  for (const [column, cell] of now.cells)
    if (!holds(cell.stamp, mine)) out.skipped.push({ table, key, column, reason: "overridden" });
}

/** Each cell of a row the write updated that still holds the write, back by its column's rule. */
function unupdate(
  mine: Stamp,
  rules: TableRules,
  { table, key, row }: RowBefore & { readonly row: Row },
  now: RowRecord,
  written: Written,
  out: Out,
) {
  const patch = new Map<ColumnName, CellValue>();
  for (const [column, wrote] of written.columns) {
    const cell = now.cells.get(column);
    if (cell === undefined || !holds(cell.stamp, mine)) {
      out.skipped.push({ table, key, column, reason: "superseded" });
      continue;
    }
    const rule = rules?.get(column) ?? "lww";
    const value = restoreCell(rule, cell.value, row.get(column) ?? null, wrote);
    if (value === undefined) out.skipped.push({ table, key, column, reason: "merge" });
    else patch.set(column, value);
  }
  if (patch.size > 0) out.changes.push({ kind: "update", table, key, patch });
}

/** One row's share of a {@link Compensation}, pushed onto `out`. */
function compensateRow(
  state: State,
  mine: Stamp,
  rules: TableRules,
  image: RowBefore,
  written: Written,
  out: Out,
): void {
  const { table, key, row } = image;
  const now = getRecord(state, table, key);
  if (row === undefined) {
    // a delete of a row that was not there took nothing away, so only an insert is undone
    if (!written.deleted) uninsert(mine, table, key, now, out);
  } else if (now === undefined || !isVisible(now)) {
    if (written.deleted && holds(now?.deleteStamp, mine)) {
      // a document column is opened and edited, never written as a value: its lineage cell
      // outlived the delete and comes back with the row
      const values = new Map([...row].filter(([column]) => rules?.get(column) !== "lineage"));
      out.changes.push({ kind: "insert", table, key, row: values });
    } else out.skipped.push({ table, key, reason: "superseded" });
  } else if (written.deleted) out.skipped.push({ table, key, reason: "superseded" });
  else unupdate(mine, rules, { table, key, row }, now, written, out);
}

const NOTHING_WRITTEN: Written = { deleted: false, columns: new Map() };

/**
 * The changes that take one write back **as far as it still stands** (RFC-0023 §9, decided in
 * §16.3): each cell whose stamp is still the write's goes back to its value before the write — a
 * `counter` by the increment that cancels the write's — and a cell someone changed since is
 * theirs, reported `superseded`. A row the write brought into being is deleted, with any cell a
 * colleague wrote since reported `overridden`; a row it deleted comes back as it was, unless
 * someone wrote it after the delete; and an update is never undone into a row someone deleted
 * since. Document updates are reported, never compensated here. `merge` names the column rules
 * of the engine the write was made on.
 */
export function compensate(state: State, { event, before }: Undo, merge?: MergeSpec): Compensation {
  const mine = stampOf(event);
  const changes: Change[] = [];
  const skipped = event.changes.flatMap((c): Skipped[] =>
    c.kind === "doc" ? [{ table: c.table, key: c.key, column: c.column, reason: "document" }] : [],
  );
  const out = { changes, skipped };
  const written = writtenRows(event.changes);
  for (const image of before)
    compensateRow(
      state,
      mine,
      merge?.get(image.table),
      image,
      written.get(rowId(image.table, image.key)) ?? NOTHING_WRITTEN,
      out,
    );
  return out;
}

export const replay = (tx: Tx, changes: readonly Change[]): void => {
  for (const c of changes) {
    if (c.kind === "insert") tx.insert(c.table, c.key, c.row);
    else if (c.kind === "update") tx.update(c.table, c.key, c.patch);
    else if (c.kind === "delete") tx.delete(c.table, c.key);
    else if (c.kind === "doc") tx.doc(c.table, c.key, docWriteOf(c));
  }
};

/**
 * What `revert` needs: the ring of revertable writes, its depth, the state now, the column rules
 * it is joined by, and the way to write.
 */
export interface RevertDeps {
  readonly undo: Undo[];
  readonly undoDepth: number;
  readonly getState: () => State;
  readonly merge: MergeSpec | undefined;
  readonly mutate: Engine["mutate"];
}

/** `entry` back at `index` in the ring, the oldest dropped if writes meanwhile filled it. */
function restore(undo: Undo[], undoDepth: number, index: number, entry: Undo): void {
  undo.splice(Math.min(index, undo.length), 0, entry);
  if (undo.length > undoDepth) undo.shift();
}

/**
 * Undo as an ordinary write (RFC-0014): the compensating event is authored, signed and folded
 * like any other, in the partition and locality of the write it answers — a peer that receives
 * it needs no idea that it was an undo. What it compensates is decided against the state as it is
 * now, cell by cell ({@link compensate}), and what it leaves alone comes back as `skipped`; when
 * nothing of the write still stands, nothing is written. A write outside the last `undoDepth` is
 * simply not revertable, which is a value rather than a throw; a compensation the engine refuses
 * leaves the write revertable.
 */
export function createRevert(deps: RevertDeps): Engine["revert"] {
  const { undo, undoDepth, getState, merge, mutate } = deps;
  return (id) => {
    const index = undo.findIndex((u) => u.event.id === id);
    const entry = undo[index];
    if (entry === undefined) {
      return Promise.resolve(
        Result.err(
          new CannotRevert({
            eventId: id,
            message: `not among the last ${undoDepth} writes of this engine`,
          }),
        ),
      );
    }
    if (entry.event.changes.every((c) => c.kind === "doc" || c.kind === "unknown")) {
      // nothing but document updates, which only their adapter can compensate: refuse before the
      // ring gives up the slot, so the write is still revertable once document undo lands
      return Promise.resolve(
        Result.err(
          new CannotRevert({
            eventId: id,
            message: "a write of document updates alone is undone by its adapter (RFC-0023 §9)",
          }),
        ),
      );
    }
    // out of the ring before the write, so a second revert of it cannot run alongside this one
    undo.splice(index, 1);
    const { changes, skipped } = compensate(getState(), entry, merge);
    if (changes.length === 0) return Promise.resolve(Result.ok({ skipped }));
    const { partition, local } = entry.event;
    const options: MutateOptions = {};
    if (partition !== undefined) Object.assign(options, { partition });
    if (local === true) Object.assign(options, { local });
    return mutate(REVERT, (tx) => replay(tx, changes), options).then((written) => {
      // a refused compensation wrote nothing, so the write is still there to revert
      if (written.isErr()) restore(undo, undoDepth, index, entry);
      return written.map((event) => ({ event, skipped }));
    });
  };
}

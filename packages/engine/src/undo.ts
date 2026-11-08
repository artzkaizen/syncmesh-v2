import type {
  CellValue,
  Change,
  ColumnName,
  Procedure,
  Row,
  RowKey,
  Stamp,
  State,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";

import { compareStamp, getRecord, isVisible, readRow, stampOf } from "@syncmesh/kernel";
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
 * Something a revert left as it found it (RFC-0023 §9). `superseded`: someone changed the cell —
 * or, with no `column`, the whole row — after the write, so their change stands. `document`: a
 * document update, which only its adapter can compensate and which this revert does not touch.
 */
export interface Skipped {
  readonly table: TableName;
  readonly key: RowKey;
  readonly column?: ColumnName;
  readonly reason: "superseded" | "document";
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

/** Per row: whether the write deleted it, and the columns it wrote. */
function writtenRows(changes: readonly Change[]) {
  const rows = new Map<string, { deleted: boolean; columns: Set<ColumnName> }>();
  for (const change of changes) {
    if (change.kind === "doc" || change.kind === "unknown") continue;
    const id = rowId(change.table, change.key);
    const entry = rows.get(id) ?? { deleted: false, columns: new Set<ColumnName>() };
    if (change.kind === "delete") entry.deleted = true;
    else
      for (const c of (change.kind === "insert" ? change.row : change.patch).keys())
        entry.columns.add(c);
    rows.set(id, entry);
  }
  return rows;
}

const holds = (stamp: Stamp | undefined, mine: Stamp) =>
  stamp !== undefined && compareStamp(stamp, mine) === 0;

/** What a revert writes, and what it leaves as it found it. */
export interface Compensation {
  readonly changes: readonly Change[];
  readonly skipped: readonly Skipped[];
}

/** One row's share of a {@link Compensation}, pushed onto `out`. */
function compensateRow(
  state: State,
  mine: Stamp,
  { table, key, row }: RowBefore,
  written: { readonly deleted: boolean; readonly columns: ReadonlySet<ColumnName> },
  out: { readonly changes: Change[]; readonly skipped: Skipped[] },
): void {
  const now = getRecord(state, table, key);
  const live = now !== undefined && isVisible(now);
  if (row === undefined) out.changes.push({ kind: "delete", table, key });
  else if (written.deleted && !live && holds(now?.deleteStamp, mine))
    out.changes.push({ kind: "insert", table, key, row });
  else if (written.deleted || !live) out.skipped.push({ table, key, reason: "superseded" });
  else {
    const patch = new Map<ColumnName, CellValue>();
    for (const column of written.columns)
      if (holds(now.cells.get(column)?.stamp, mine)) patch.set(column, row.get(column) ?? null);
      else out.skipped.push({ table, key, column, reason: "superseded" });
    if (patch.size > 0) out.changes.push({ kind: "update", table, key, patch });
  }
}

const NOTHING_WRITTEN = { deleted: false, columns: new Set<ColumnName>() };

/**
 * The changes that take one write back **as far as it still stands** (RFC-0023 §9, decided in
 * §16.3): each cell whose stamp is still the write's goes back to its value before the write; a
 * cell someone changed since is theirs, and is reported `superseded` instead. A row the write
 * brought into being is deleted, and a row it deleted comes back as it was — unless someone
 * wrote it after the delete, and an update is never undone into a row someone deleted since.
 * Document updates are reported, never compensated here.
 */
export function compensate(state: State, { event, before }: Undo): Compensation {
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

/** What `revert` needs: the ring of revertable writes, its depth, the state now, and the way to write. */
export interface RevertDeps {
  readonly undo: Undo[];
  readonly undoDepth: number;
  readonly getState: () => State;
  readonly mutate: Engine["mutate"];
}

/**
 * Undo as an ordinary write (RFC-0014): the compensating event is authored, signed and folded
 * like any other, in the partition and locality of the write it answers — a peer that receives
 * it needs no idea that it was an undo. What it compensates is decided against the state as it is
 * now, cell by cell ({@link compensate}), and what it leaves alone comes back as `skipped`; when
 * nothing of the write still stands, nothing is written. A write outside the last `undoDepth` is
 * simply not revertable, which is a value rather than a throw.
 */
export function createRevert(deps: RevertDeps): Engine["revert"] {
  const { undo, undoDepth, getState, mutate } = deps;
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
    undo.splice(index, 1);
    const { changes, skipped } = compensate(getState(), entry);
    if (changes.length === 0) return Promise.resolve(Result.ok({ skipped }));
    const { partition, local } = entry.event;
    const options: MutateOptions = {};
    if (partition !== undefined) Object.assign(options, { partition });
    if (local === true) Object.assign(options, { local });
    return mutate(REVERT, (tx) => replay(tx, changes), options).then((written) =>
      written.map((event) => ({ event, skipped })),
    );
  };
}

/**
 * `revert` (RFC-0014): a write taken back as an ordinary write, from the compensation `undo.ts`
 * decides against the state as it is now.
 */
import type {
  Change,
  ColumnName,
  DocChange,
  EventId,
  MergeSpec,
  Procedure,
  RowKey,
  State,
  TableName,
} from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { Engine, MutateOptions } from "./engine.js";
import type { DocWrite, Tx } from "./tx.js";
import type { Validator } from "./validate.js";

import { CannotRevert, type RevertError } from "./errors.js";
import { docWriteOf } from "./tx.js";
import { compensate, type Reverted, type Skipped, type Undo } from "./undo.js";

const revertProcedure = (): Procedure => {
  // SAFETY: the one procedure the engine itself authors; naming rules arrive with the client
  return "revert" as Procedure;
};

const REVERT = revertProcedure();

export const replay = (tx: Tx, changes: readonly Change[]): void => {
  for (const c of changes) {
    if (c.kind === "insert") tx.insert(c.table, c.key, c.row);
    else if (c.kind === "update") tx.update(c.table, c.key, c.patch);
    else if (c.kind === "delete") tx.delete(c.table, c.key);
    else if (c.kind === "doc") tx.doc(c.table, c.key, docWriteOf(c));
  }
};

/**
 * What a document runtime writes to take back one document's updates in a reverted write
 * (RFC-0023 §9, E30 P6): the doc writes of the compensation — an update made against the document
 * as it is now, or a genesis bringing back the lineage a `replace()` ended — or none when nothing
 * of the write still stands there, which the revert reports `superseded`.
 */
export interface DocCompensation {
  readonly table: TableName;
  readonly key: RowKey;
  readonly column: ColumnName;
  readonly writes: readonly DocWrite[];
}

/**
 * Compensates a reverted write's document updates, every document at once: only a runtime holding
 * the adapter can, since the engine never runs one (RFC-0023 §6.4). A refusal reverts nothing and
 * leaves the write revertable.
 */
export type DocCompensator = (
  changes: readonly DocChange[],
  eventId: EventId,
) => Promise<Result<readonly DocCompensation[], CannotRevert>>;

/**
 * What `revert` needs: the ring of revertable writes, its depth, the state now, the column rules
 * it is joined by, the validator, and the way to write.
 */
export interface RevertDeps {
  readonly undo: Undo[];
  readonly undoDepth: number;
  readonly getState: () => State;
  readonly merge: MergeSpec | undefined;
  /** Names the retired columns a compensating insert leaves out (D31). */
  readonly validate: Validator | undefined;
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
  const { undo, undoDepth, getState, merge, validate, mutate } = deps;
  return (id, docs) => {
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
    if (
      docs === undefined &&
      entry.event.changes.every((c) => c.kind === "doc" || c.kind === "unknown")
    ) {
      // nothing but document updates, which only their adapter can compensate: refuse before the
      // ring gives up the slot, so the write is still revertable through a document runtime
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
    const { changes, skipped } = compensate(getState(), entry, merge, validate?.retiredColumn);
    const { partition, local } = entry.event;
    const options: MutateOptions = {};
    if (partition !== undefined) Object.assign(options, { partition });
    if (local === true) Object.assign(options, { local });
    const write = (
      writes: readonly DocCompensation[],
      left: readonly Skipped[],
    ): Promise<Result<Reverted, RevertError>> => {
      if (changes.length === 0 && writes.length === 0)
        return Promise.resolve(Result.ok<Reverted>({ skipped: left }));
      return mutate(
        REVERT,
        (tx) => {
          replay(tx, changes);
          for (const { table, key, writes: each } of writes)
            for (const doc of each) tx.doc(table, key, doc);
        },
        options,
      ).then((written) => {
        // a refused compensation wrote nothing, so the write is still there to revert
        if (written.isErr()) restore(undo, undoDepth, index, entry);
        return written.map((event): Reverted => ({ event, skipped: left }));
      });
    };
    if (docs === undefined) return write([], skipped);
    const docChanges = entry.event.changes.filter((c) => c.kind === "doc");
    return docs(docChanges, id).then((compensated): Promise<Result<Reverted, RevertError>> => {
      if (compensated.isErr()) {
        restore(undo, undoDepth, index, entry);
        return Promise.resolve(Result.err(compensated.error));
      }
      const rows = skipped.filter((s) => s.reason !== "document");
      const gone = compensated.value.flatMap(({ table, key, column, writes }): Skipped[] =>
        writes.length === 0 ? [{ table, key, column, reason: "superseded" }] : [],
      );
      const kept = compensated.value.filter(({ writes }) => writes.length > 0);
      return write(kept, [...rows, ...gone]);
    });
  };
}

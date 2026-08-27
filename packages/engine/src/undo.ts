import type { Change, ColumnName, State } from "@syncmesh/kernel";
import type { Procedure, SyncEvent } from "@syncmesh/kernel";

import { readRow } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { Engine, MutateOptions } from "./engine.js";
import type { Tx } from "./tx.js";

import { CannotRevert } from "./errors.js";

export interface Undo {
  readonly event: SyncEvent;
  readonly inverse: readonly Change[];
}

const revertProcedure = (): Procedure => {
  // SAFETY: the one procedure the engine itself authors; naming rules arrive with the client (E09)
  return "revert" as Procedure;
};

export const REVERT = revertProcedure();

/** One change per touched row that restores it to how it was before the whole event. */
export function invert(state: State, changes: readonly Change[]): readonly Change[] {
  const touched = new Map<string, { change: Change; columns: Set<ColumnName>; deleted: boolean }>();
  for (const change of changes) {
    const id = `${change.table}\u0000${change.key}`;
    const entry = touched.get(id) ?? { change, columns: new Set<ColumnName>(), deleted: false };
    if (change.kind === "delete") entry.deleted = true;
    else
      for (const c of (change.kind === "insert" ? change.row : change.patch).keys())
        entry.columns.add(c);
    touched.set(id, entry);
  }
  const inverse: Change[] = [];
  for (const { change, columns, deleted } of touched.values()) {
    const { table, key } = change;
    const before = readRow(state, table, key);
    if (before === undefined) inverse.push({ kind: "delete", table, key });
    else if (deleted) inverse.push({ kind: "insert", table, key, row: before });
    else
      inverse.push({
        kind: "update",
        table,
        key,
        patch: new Map([...columns].map((c) => [c, before.get(c) ?? null])),
      });
  }
  return inverse;
}

export const replay = (tx: Tx, changes: readonly Change[]): void => {
  for (const c of changes) {
    if (c.kind === "insert") tx.insert(c.table, c.key, c.row);
    else if (c.kind === "update") tx.update(c.table, c.key, c.patch);
    else tx.delete(c.table, c.key);
  }
};

/** What `revert` needs: the ring of revertable writes, its depth, and the way to write one. */
export interface RevertDeps {
  readonly undo: Undo[];
  readonly undoDepth: number;
  readonly mutate: Engine["mutate"];
}

/**
 * Undo as an ordinary write (RFC-0014): the compensating event is authored, signed and folded
 * like any other, in the partition and locality of the write it answers — a peer that receives
 * it needs no idea that it was an undo. A write outside the last `undoDepth` is simply not
 * revertable, which is a value rather than a throw.
 */
export function createRevert(deps: RevertDeps): Engine["revert"] {
  const { undo, undoDepth, mutate } = deps;
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
    undo.splice(index, 1);
    const { partition, local } = entry.event;
    const options: MutateOptions = {};
    if (partition !== undefined) Object.assign(options, { partition });
    if (local === true) Object.assign(options, { local });
    return mutate(REVERT, (tx) => replay(tx, entry.inverse), options);
  };
}

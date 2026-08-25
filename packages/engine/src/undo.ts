import type { Change, ColumnName, State } from "@syncmesh/kernel";
import type { Procedure, SyncEvent } from "@syncmesh/kernel";

import { readRow } from "@syncmesh/kernel";

import type { Tx } from "./tx.js";

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

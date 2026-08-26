import type { Engine, Unsubscribe } from "@syncmesh/engine";
import type { RowKey, TableName } from "@syncmesh/kernel";
import type { Row, Table } from "@syncmesh/schema";

import { createHub } from "@syncmesh/engine";

import type { Visible } from "./live-query.js";
import type { QuerySpec } from "./query.js";

import { createLiveQuery } from "./live-query.js";
import { specKey } from "./query.js";

/** A maintained result from `mesh.liveQuery`; give it back through `mesh.releaseQuery` when done. */
export interface LiveHandle<T extends Table> {
  readonly data: () => readonly Row<T>[];
  /** Fires at most once per fold batch, and only when this result changed. */
  readonly subscribe: (listener: () => void) => Unsubscribe;
}

/** A held live result. `release` when done; identical descriptors share one maintained result. */
export interface QueryHandle<T extends Table> {
  readonly rows: () => readonly Row<T>[];
  /** Fires at most once per fold batch, and only when this result changed. */
  readonly subscribe: (listener: () => void) => Unsubscribe;
  readonly release: () => void;
}

interface Held {
  readonly table: TableName;
  readonly query: ReturnType<typeof createLiveQuery>;
  readonly hub: ReturnType<typeof createHub<void>>;
  refs: number;
}

export interface QueryRegistry {
  readonly acquire: <T extends Table>(
    table: T,
    spec: QuerySpec<T>,
    visible: Visible,
    scope?: string,
  ) => QueryHandle<T>;
  /** Re-points every query (an `activate` changed what is visible) and notifies the ones that moved. */
  readonly rescanAll: () => void;
  /** Open maintained results, shared or not. */
  readonly size: () => number;
}

export function createQueryRegistry(engine: Engine): QueryRegistry {
  const shared = new Map<string, Held>();
  const all = new Set<Held>();

  engine.onFoldBatch((batch) => {
    const changed: Held[] = [];
    for (const held of all) {
      const keys: ReadonlySet<RowKey> | undefined = batch.writeKeys.get(held.table);
      if (keys !== undefined && held.query.apply(keys)) changed.push(held);
    }
    for (const held of changed) held.hub.emit(undefined);
  });

  const drop = (key: string | undefined, held: Held): void => {
    held.refs -= 1;
    if (held.refs > 0) return;
    all.delete(held);
    if (key !== undefined) shared.delete(key);
  };

  return {
    acquire: <T extends Table>(table: T, spec: QuerySpec<T>, visible: Visible, scope?: string) => {
      const key = specKey(table, spec, scope);
      const existing = key === undefined ? undefined : shared.get(key);
      const held: Held = existing ?? {
        table: table.name,
        // SAFETY: the handle returned below narrows rows() back to Row<T>; the registry stores queries untyped
        query: createLiveQuery(table, spec, visible) as ReturnType<typeof createLiveQuery>,
        hub: createHub<void>(),
        refs: 0,
      };
      if (existing === undefined) {
        all.add(held);
        if (key !== undefined) shared.set(key, held);
      }
      held.refs += 1;
      let released = false;
      return {
        // SAFETY: this query was created for this table's spec; rows are Row<T>
        rows: () => held.query.rows() as readonly Row<T>[],
        subscribe: held.hub.subscribe,
        release: () => {
          if (released) return;
          released = true;
          drop(key, held);
        },
      };
    },
    rescanAll: () => {
      const changed: Held[] = [];
      for (const held of all) if (held.query.rescan()) changed.push(held);
      for (const held of changed) held.hub.emit(undefined);
    },
    size: () => all.size,
  };
}

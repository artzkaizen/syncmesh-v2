import type { RowKey, RowRecord, State, SyncEvent, TableName } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import type { StoreFailure } from "./store.js";
import type { Cursors } from "./sync.js";

/** A persisted row failed to decode; the cache is rebuilt from the log. */
export class StateCorrupt extends TaggedError("StateCorrupt")<{ message: string }> {}

/** The sequence numbers a state has folded, per author and scope. */
export interface Coverage {
  readonly synced: Cursors;
  readonly local: Cursors;
}

export const EMPTY_COVERAGE: Coverage = { synced: new Map(), local: new Map() };

export interface RowWrite {
  readonly table: TableName;
  readonly key: RowKey;
  readonly record: RowRecord;
}

/** Materialised rows and the coverage they reflect, so boot opens state instead of refolding the log. A cache: the log stays the truth. See RFC-0004. */
export interface StateStore {
  readonly isEmpty: () => Promise<Result<boolean, StoreFailure>>;
  /** Every persisted row; `StateCorrupt` if any one fails to decode — a partial state is never returned. */
  readonly loadAll: () => Promise<Result<State, StoreFailure | StateCorrupt>>;
  readonly loadCursors: () => Promise<Result<Coverage, StoreFailure | StateCorrupt>>;
  /** Rows and coverage land together or not at all. */
  readonly commit: (
    rows: readonly RowWrite[],
    coverage: Coverage,
  ) => Promise<Result<void, StoreFailure>>;
  readonly clear: () => Promise<Result<void, StoreFailure>>;
}

export type WriteKeys = ReadonlyMap<TableName, ReadonlySet<RowKey>>;

/** Every (table, key) the events touch. */
export function writeKeysOf(events: readonly SyncEvent[]): WriteKeys {
  const keys = new Map<TableName, Set<RowKey>>();
  for (const event of events) {
    for (const change of event.changes) {
      const set = keys.get(change.table) ?? new Set<RowKey>();
      set.add(change.key);
      keys.set(change.table, set);
    }
  }
  return keys;
}

/** The records currently held for `keys`; a key with no record is skipped. */
export function rowsFor(state: State, keys: WriteKeys): readonly RowWrite[] {
  const rows: RowWrite[] = [];
  for (const [table, set] of keys) {
    const records = state.get(table);
    for (const key of set) {
      const record = records?.get(key);
      if (record !== undefined) rows.push({ table, key, record });
    }
  }
  return rows;
}

export function allRows(state: State): readonly RowWrite[] {
  const rows: RowWrite[] = [];
  for (const [table, records] of state)
    for (const [key, record] of records) rows.push({ table, key, record });
  return rows;
}

export function createMemoryStateStore(): StateStore {
  const tables = new Map<TableName, Map<RowKey, RowRecord>>();
  let coverage = EMPTY_COVERAGE;
  const ok = <T>(value: T) => Promise.resolve(Result.ok(value));
  const copy = (): State => new Map([...tables].map(([t, rows]) => [t, new Map(rows)]));

  return {
    isEmpty: () => ok(coverage.synced.size === 0 && coverage.local.size === 0),
    loadAll: () => ok(copy()),
    loadCursors: () => ok(coverage),
    commit: (rows, next) => {
      for (const { table, key, record } of rows) {
        const records = tables.get(table) ?? new Map<RowKey, RowRecord>();
        records.set(key, record);
        tables.set(table, records);
      }
      coverage = { synced: new Map(next.synced), local: new Map(next.local) };
      return ok(undefined);
    },
    clear: () => {
      tables.clear();
      coverage = EMPTY_COVERAGE;
      return ok(undefined);
    },
  };
}

import type { Row, RowKey, RowRecord, State, SyncEvent, TableName } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import type { StoreFailure } from "./store.js";
import type { Coverage } from "./sync.js";

import { EMPTY_COVERAGE } from "./sync.js";

/** A persisted row failed to decode; the cache is rebuilt from the log. */
export class StateCorrupt extends TaggedError("StateCorrupt")<{ message: string }> {}

export interface RowWrite {
  readonly table: TableName;
  readonly key: RowKey;
  readonly record: RowRecord;
}

/**
 * Values a replica computed from a document for one row's derived columns (RFC-0023 §16.4). They
 * land in the app's row only: never a cell, never in a digest, never on the wire.
 */
export interface DerivedRow {
  readonly table: TableName;
  readonly key: RowKey;
  readonly values: Row;
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
  /**
   * Drops these rows — from the cache and from whatever the store projects them into — as if no
   * event had ever written them. What a purge does to rows this device may no longer read (D45);
   * a key with no row is skipped.
   */
  readonly remove: (keys: WriteKeys) => Promise<Result<void, StoreFailure>>;
  /**
   * Writes derived values into the app's rows, outside the record and outside capture; a row not
   * there yet is skipped. Absent where there are no app tables to write them to.
   */
  readonly derive?: (rows: readonly DerivedRow[]) => Promise<Result<void, StoreFailure>>;
}

export type WriteKeys = ReadonlyMap<TableName, ReadonlySet<RowKey>>;

/**
 * Every (table, key) whose record the events can move. A doc change counts only as a genesis —
 * the one kind that sets a cell — so a document edit never re-runs a live query (RFC-0023 §4.2).
 */
export function eventWriteKeys(events: readonly SyncEvent[]): WriteKeys {
  const keys = new Map<TableName, Set<RowKey>>();
  for (const event of events) {
    for (const change of event.changes) {
      if (change.kind === "doc" && change.genesis !== true) continue;
      const set = keys.get(change.table) ?? new Set<RowKey>();
      set.add(change.key);
      keys.set(change.table, set);
    }
  }
  return keys;
}

/** The records currently held for `keys`; a key with no record is skipped. */
export function rowWrites(state: State, keys: WriteKeys): readonly RowWrite[] {
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

/**
 * A state store held in memory, for tests and for a mesh whose log is in memory too.
 *
 * Pair it with a persistent log only knowing the cost: after one snapshot install the log records
 * the install's floor, and every later boot finds this store empty over it, rebuilds without the
 * installed rows and raises them as a `$recovery` issue until peers send them again (gaps U33).
 */
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
      coverage = {
        synced: new Map(next.synced),
        local: new Map(next.local),
        ...(next.floor !== undefined && { floor: new Map(next.floor) }),
        ...(next.scope !== undefined && { scope: next.scope }),
        ...(next.held !== undefined && { held: new Map(next.held) }),
      };
      return ok(undefined);
    },
    clear: () => {
      tables.clear();
      coverage = EMPTY_COVERAGE;
      return ok(undefined);
    },
    remove: (keys) => {
      for (const [table, set] of keys) for (const key of set) tables.get(table)?.delete(key);
      return ok(undefined);
    },
  };
}

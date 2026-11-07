import type { Row, RowKey, TableName } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import type { WindowRow } from "./frames.js";
import type { SortKey, WindowQuery } from "./query.js";

import { compareSortKeys, sortKey } from "./query.js";

/** A row that now holds this value, or (`row` absent) a row that is gone. */
export interface RowChange {
  readonly table: TableName;
  readonly key: RowKey;
  readonly row?: Row;
}

export class UnknownTable extends TaggedError("UnknownTable")<{
  table: TableName;
  message: string;
}> {}

/**
 * Whatever holds the rows a window is cut from (D39): an engine's state, a Postgres table
 * through E17, or memory. It answers one question and reports one thing, and the view does the
 * rest.
 */
export interface RowSource {
  /**
   * The first `query.limit` rows of `query.table`, in `query.order`, strictly after
   * `query.after`, for which `accepts` holds. A source may narrow with `query.where` first, as a
   * Postgres source compiles it to SQL, but `accepts` has the last word: it carries the reader's
   * read policy, which a `where` only ever narrows (E13).
   */
  readonly window: (
    query: WindowQuery,
    accepts: (row: Row) => boolean,
  ) => Result<readonly WindowRow[], UnknownTable>;
  /** Changes, as batches, in the order they committed. Returns the unsubscribe. */
  readonly subscribe: (listener: (changes: readonly RowChange[]) => void) => () => void;
}

export interface MemoryRowSourceOptions {
  /**
   * Sorted indexes one table keeps, each one entry per row. An order past it drops the index
   * used least recently, and the next window over that order rebuilds it in O(n log n). The
   * source's memory is therefore at most `maxIndexes` entries per row, whatever orders clients
   * name.
   * @default 8
   */
  readonly maxIndexes?: number;
}

/** The {@link MemoryRowSourceOptions.maxIndexes} a memory source takes when none is given. */
export const MAX_INDEXES = 8;

/**
 * A memory source: a table is a map, and every order a window asks for is a sorted index, of
 * which a table keeps at most `maxIndexes`.
 */
export interface MemoryRowSource extends RowSource {
  /** Applies changes in one batch and tells every subscriber once. */
  readonly write: (changes: readonly RowChange[]) => void;
  /** Fills a table without telling anyone, as a source has rows before any window opens. */
  readonly load: (table: TableName, rows: Iterable<WindowRow>) => void;
  /** How many rows the last `window` call looked at, which is what bounds its time. */
  readonly scanned: () => number;
  /** Sorted indexes held across every table, which with the rows is what bounds its memory. */
  readonly indexed: () => number;
}

interface Entry {
  readonly sort: SortKey;
  readonly row: Row;
}

interface Index {
  readonly order: WindowQuery["order"];
  /** Ascending under `order`: the window's first row is the first entry after the bound. */
  readonly entries: Entry[];
}

/** The first position whose entry sorts after `bound`, by binary search. */
const firstAfter = (index: Index, bound: SortKey): number => {
  let lo = 0;
  let hi = index.entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // SAFETY: lo <= mid < hi <= length
    const entry = index.entries[mid] as Entry;
    if (compareSortKeys(index.order, entry.sort, bound) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** Where an entry with exactly this sort key is, or would go. */
const lowerBound = (index: Index, at: SortKey): number => {
  let lo = 0;
  let hi = index.entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // SAFETY: lo <= mid < hi <= length
    const entry = index.entries[mid] as Entry;
    if (compareSortKeys(index.order, entry.sort, at) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

export function createMemoryRowSource(options: MemoryRowSourceOptions = {}): MemoryRowSource {
  const { maxIndexes = MAX_INDEXES } = options;
  const tables = new Map<TableName, Map<RowKey, Row>>();
  /**
   * Per table, per order (as JSON), the sorted index a window over that order reads, least
   * recently used first.
   */
  const indexes = new Map<TableName, Map<string, Index>>();
  const listeners = new Set<(changes: readonly RowChange[]) => void>();
  let scanned = 0;

  const tableRows = (table: TableName): Map<RowKey, Row> => {
    let rows = tables.get(table);
    if (rows === undefined) {
      rows = new Map();
      tables.set(table, rows);
    }
    return rows;
  };

  const build = (rows: Map<RowKey, Row>, order: WindowQuery["order"]): Index => {
    const entries: Entry[] = [];
    for (const [key, row] of rows) entries.push({ sort: sortKey(order, key, row), row });
    entries.sort((a, b) => compareSortKeys(order, a.sort, b.sort));
    return { order, entries };
  };

  const orderIndex = (table: TableName, order: WindowQuery["order"]): Index => {
    const byOrder = indexes.get(table) ?? new Map<string, Index>();
    indexes.set(table, byOrder);
    const name = JSON.stringify(order);
    const found = byOrder.get(name);
    byOrder.delete(name);
    if (found !== undefined) {
      byOrder.set(name, found);
      return found;
    }
    for (const stale of byOrder.keys()) {
      if (byOrder.size < maxIndexes) break;
      byOrder.delete(stale);
    }
    const built = build(tableRows(table), order);
    byOrder.set(name, built);
    return built;
  };

  const unindex = (table: TableName, key: RowKey, row: Row): void => {
    for (const index of indexes.get(table)?.values() ?? []) {
      const at = lowerBound(index, sortKey(index.order, key, row));
      if (index.entries[at]?.sort.key === key) index.entries.splice(at, 1);
    }
  };

  const reindex = (table: TableName, key: RowKey, row: Row): void => {
    for (const index of indexes.get(table)?.values() ?? []) {
      const sort = sortKey(index.order, key, row);
      index.entries.splice(lowerBound(index, sort), 0, { sort, row });
    }
  };

  return {
    window: (query, accepts) => {
      const rows = tables.get(query.table);
      if (rows === undefined)
        return Result.err(
          new UnknownTable({ table: query.table, message: `no table ${query.table}` }),
        );
      const index = orderIndex(query.table, query.order);
      const start = query.after === undefined ? 0 : firstAfter(index, query.after);
      const out: WindowRow[] = [];
      scanned = 0;
      for (let i = start; i < index.entries.length && out.length < query.limit; i++) {
        // SAFETY: i is inside the entries' bounds
        const entry = index.entries[i] as Entry;
        scanned++;
        if (accepts(entry.row)) out.push({ key: entry.sort.key, row: entry.row });
      }
      return Result.ok(out);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    write: (changes) => {
      for (const change of changes) {
        const rows = tableRows(change.table);
        const before = rows.get(change.key);
        if (before !== undefined) unindex(change.table, change.key, before);
        if (change.row === undefined) rows.delete(change.key);
        else {
          rows.set(change.key, change.row);
          reindex(change.table, change.key, change.row);
        }
      }
      for (const listener of listeners) listener(changes);
    },
    load: (table, rows) => {
      const held = tableRows(table);
      for (const { key, row } of rows) held.set(key, row);
      const byOrder = indexes.get(table);
      for (const [name, index] of byOrder ?? []) byOrder?.set(name, build(held, index.order));
    },
    scanned: () => scanned,
    indexed: () => [...indexes.values()].reduce((sum, byOrder) => sum + byOrder.size, 0),
  };
}

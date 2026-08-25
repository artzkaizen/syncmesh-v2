import type { RowKey, Row as WireCells } from "@syncmesh/kernel";
import type { Row, Table } from "@syncmesh/schema";

import { fromWireRow } from "@syncmesh/schema";

import type { QuerySpec } from "./query.js";

import { compareRows, matches } from "./query.js";

interface Entry<T extends Table> {
  readonly key: string;
  readonly row: Row<T>;
}

/** Content equality; row values are JSON-representable (Instants stringify to ISO). */
const sameEntry = <T extends Table>(a: Entry<T>, b: Entry<T> | undefined): boolean =>
  b !== undefined && a.key === b.key && JSON.stringify(a.row) === JSON.stringify(b.row);

/** What a live query reads from: the visible rows of its table in the active instance. */
export type Visible = () => ReadonlyMap<RowKey, WireCells>;

/**
 * One maintained result: the filtered rows in the spec's order. A fold batch updates it per touched
 * key — enter, leave, move, or update in place — by binary search; only a spec it cannot attribute
 * (first run, re-pointed partition) costs a full scan. Equal to a re-run, always (D11).
 */
export interface LiveQuery<T extends Table> {
  readonly rows: () => readonly Row<T>[];
  /** Applies the touched keys; `true` when the result changed. */
  readonly apply: (keys: ReadonlySet<RowKey>) => boolean;
  /** Rebuilds from scratch; `true` when the result changed. */
  readonly rescan: () => boolean;
}

export function createLiveQuery<T extends Table>(
  table: T,
  spec: QuerySpec<T>,
  visible: Visible,
): LiveQuery<T> {
  let entries: Entry<T>[] = [];
  const held = new Map<string, Row<T>>();
  const compare = (a: Entry<T>, b: Entry<T>) => compareRows(spec.orderBy, a, b);

  /** Leftmost index whose entry sorts at or after `entry`. */
  const positionOf = (entry: Entry<T>): number => {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      // SAFETY: mid < entries.length inside the loop
      if (compare(entries[mid] as Entry<T>, entry) < 0) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  const remove = (key: string, row: Row<T>): void => {
    const at = positionOf({ key, row });
    if (entries[at]?.key === key) entries.splice(at, 1);
    held.delete(key);
  };
  const insert = (entry: Entry<T>): void => {
    entries.splice(positionOf(entry), 0, entry);
    held.set(entry.key, entry.row);
  };

  const applyOne = (key: string, cells: WireCells | undefined): boolean => {
    const previous = held.get(key);
    const next = cells === undefined ? undefined : fromWireRow(table, cells);
    const wanted = next !== undefined && matches(spec.where, next);
    if (previous === undefined && !wanted) return false;
    if (previous === undefined && next !== undefined) {
      insert({ key, row: next });
      return true;
    }
    if (previous !== undefined && !wanted) {
      remove(key, previous);
      return true;
    }
    if (previous === undefined || next === undefined) return false;
    remove(key, previous);
    insert({ key, row: next });
    return true;
  };

  const rescan = (): boolean => {
    const before = entries;
    entries = [];
    held.clear();
    for (const [key, cells] of visible()) {
      const row = fromWireRow(table, cells);
      if (matches(spec.where, row)) {
        entries.push({ key: String(key), row });
        held.set(String(key), row);
      }
    }
    entries.sort(compare);
    return before.length !== entries.length || before.some((e, i) => !sameEntry(e, entries[i]));
  };
  rescan();

  return {
    rows: () => entries.map((e) => e.row),
    apply: (keys) => {
      const rows = visible();
      let changed = false;
      for (const key of keys) {
        // SAFETY: RowKey is a branded string; the entry map keys by its text
        if (applyOne(String(key), rows.get(key))) changed = true;
      }
      return changed;
    },
    rescan,
  };
}

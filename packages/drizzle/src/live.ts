import type { Engine } from "@syncmesh/engine";
import type { SQLChunk, SQLWrapper } from "drizzle-orm";

import { Column, SQL, Subquery, Table, getTableName, is } from "drizzle-orm";

export interface Live<T> {
  /** The rows as of the last run; `undefined` until `ready` resolves. */
  readonly data: () => readonly T[] | undefined;
  readonly ready: Promise<readonly T[]>;
  /** Fires once per fold batch that touched one of the query's tables, and only when the rows changed. */
  readonly subscribe: (listener: (rows: readonly T[]) => void) => () => void;
  readonly release: () => void;
}

/** What a live query needs from a Drizzle query: its SQL to find the tables, and to be awaited. */
export type Runnable<T> = SQLWrapper & PromiseLike<readonly T[]>;

/** Every table a query's SQL mentions, through columns, subqueries and nested fragments. */
const tablesOf = (query: SQLWrapper): ReadonlySet<string> => {
  const names = new Set<string>();
  const walk = (chunk: SQLChunk): void => {
    if (is(chunk, Table)) names.add(getTableName(chunk));
    else if (is(chunk, Column)) names.add(getTableName(chunk.table));
    else if (is(chunk, Subquery)) walk(chunk._.sql);
    else if (is(chunk, SQL)) for (const inner of chunk.queryChunks) walk(inner);
  };
  walk(query.getSQL());
  return names;
};

/** A live query is a re-run on exact invalidation (D20 §4): the fold names the tables it touched. */
export const createLive =
  (engine: Engine) =>
  <T>(query: Runnable<T>): Live<T> => {
    const touched = tablesOf(query);
    const listeners = new Set<(rows: readonly T[]) => void>();
    let current: readonly T[] | undefined;
    let last = "";
    const run = async (): Promise<readonly T[]> => {
      const rows = await query;
      const key = JSON.stringify(rows);
      const changed = key !== last;
      last = key;
      current = rows;
      if (changed) for (const listener of listeners) listener(rows);
      return rows;
    };
    const ready = run();
    const off = engine.onFoldBatch((batch) => {
      for (const table of batch.writeTables) {
        if (touched.has(String(table))) {
          void run();
          return;
        }
      }
    });
    return {
      data: () => current,
      ready,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      release: off,
    };
  };

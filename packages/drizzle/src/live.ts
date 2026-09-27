import type { Engine } from "@syncmesh/engine";
import type { SQLChunk, SQLWrapper } from "drizzle-orm";

import {
  Column,
  Param,
  SQL,
  StringChunk,
  Subquery,
  Table,
  getColumnTable,
  getTableName,
  is,
} from "drizzle-orm";

import { replaceEqualDeep } from "./equal.js";

/**
 * What a consumer reads, as one object whose **identity changes only when something changed** —
 * which is what lets `useSyncExternalStore` hold it without tearing, and what stops a component
 * re-rendering because an unrelated table was written.
 */
export interface LiveSnapshot<T> {
  /** Empty while pending, so a list never has to null-check. */
  readonly data: readonly T[];
  readonly status: "pending" | "error" | "success";
  readonly error: Error | undefined;
}

export interface Live<T> {
  /** The rows as of the last run; `undefined` until `ready` resolves. */
  readonly data: () => readonly T[] | undefined;
  /** The cached snapshot. Same reference until the rows or the error actually change. */
  readonly snapshot: () => LiveSnapshot<T>;
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
    else if (is(chunk, Column)) names.add(getTableName(getColumnTable(chunk)));
    else if (is(chunk, Subquery)) walk(chunk._.sql);
    else if (is(chunk, SQL)) for (const inner of chunk.queryChunks) walk(inner);
  };
  walk(query.getSQL());
  return names;
};

const EMPTY: readonly never[] = [];

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/**
 * A query's identity for sharing: every table, column, literal and bind it names, in order.
 *
 * Walked from the typed chunk tree rather than `toSQL()`, for the same reason {@link tablesOf}
 * is — the tree is what Drizzle guarantees, and reading it needs no assertion about a shape the
 * builder never promised.
 */
const identityOf = (query: Runnable<unknown>): string => {
  const parts: string[] = [];
  const walk = (chunk: SQLChunk): void => {
    if (is(chunk, Table)) parts.push(`t:${getTableName(chunk)}`);
    else if (is(chunk, Column))
      parts.push(`c:${getTableName(getColumnTable(chunk))}.${chunk.name}`);
    else if (is(chunk, Subquery)) walk(chunk._.sql);
    else if (is(chunk, Param)) parts.push(`p:${JSON.stringify(chunk.value) ?? "?"}`);
    else if (is(chunk, StringChunk)) parts.push(`s:${chunk.value.join("")}`);
    else if (is(chunk, SQL)) for (const inner of chunk.queryChunks) walk(inner);
    else parts.push("?"); // a chunk kind this build does not name: never shared, always safe
  };
  walk(query.getSQL());
  return parts.join("\u0000");
};

/**
 * A live query is a re-run on exact invalidation (D20 §4): the fold names the tables it touched.
 *
 * Two queries asking the same question share one subscription and one re-run, refcounted by
 * `release` — two components rendering the same list used to run the same SQL twice per fold.
 */
export const createLive = (engine: Engine) => {
  const shared = new Map<string, { readonly live: Live<never>; refs: number }>();

  const build = <T>(query: Runnable<T>): Live<T> => {
    const touched = tablesOf(query);
    const listeners = new Set<(rows: readonly T[]) => void>();
    let current: readonly T[] | undefined;
    let snap: LiveSnapshot<T> = { data: EMPTY, status: "pending", error: undefined };

    const run = async (): Promise<readonly T[]> => {
      let fresh: readonly T[];
      try {
        fresh = await query;
      } catch (cause) {
        const error = asError(cause);
        // a failed run keeps the last good rows: a transient error must not blank a list
        snap = { data: snap.data, status: "error", error };
        for (const listener of listeners) listener(snap.data);
        throw error;
      }
      // identity is the change decision, and every unchanged row keeps its reference
      const rows = current === undefined ? fresh : replaceEqualDeep(current, fresh);
      const changed = rows !== current || snap.status !== "success";
      current = rows;
      if (changed) {
        snap = { data: rows, status: "success", error: undefined };
        for (const listener of listeners) listener(rows);
      }
      return rows;
    };

    /**
     * One run at a time, and one more if anything arrived while it was out.
     *
     * Two folds landing during one in-flight query used to start two runs whose `await`s could
     * settle in either order, so the **older** result could be the one that stuck. Coalescing
     * also collapses a burst — a catch-up of a thousand events is one re-run, not a thousand.
     */
    let running = false;
    let again = false;
    const schedule = (): void => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      void run()
        .catch(() => undefined)
        .finally(() => {
          running = false;
          if (!again) return;
          again = false;
          schedule();
        });
    };

    running = true;
    const ready = run().finally(() => {
      running = false;
      if (!again) return;
      again = false;
      schedule();
    });

    const off = engine.onFoldBatch((batch) => {
      for (const table of batch.writeTables)
        if (touched.has(String(table))) {
          schedule();
          return;
        }
    });

    return {
      data: () => current,
      snapshot: () => snap,
      ready,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      release: off,
    };
  };

  const drop = (id: string): void => {
    const held = shared.get(id);
    if (held === undefined) return;
    held.refs -= 1;
    if (held.refs > 0) return;
    shared.delete(id);
    held.live.release();
  };

  /* oxlint-disable anti-slop/no-chained-type-assertions -- one shared map cannot be typed per query, and no narrower type spans two different ones; the key is what fixes the row shape */
  return <T>(query: Runnable<T>): Live<T> => {
    const id = identityOf(query);
    const held = shared.get(id);
    if (held !== undefined) {
      held.refs += 1;
      // SAFETY: the map is keyed by the query's own chunk tree, which is exactly what fixes the row shape — only a caller asking the identical question reads this entry back
      const live = held.live as unknown as Live<T>;
      return { ...live, release: () => drop(id) };
    }
    const live = build(query);
    // SAFETY: erased on the way in and restored on the way out under the same key; the entry is unreachable except through that key
    shared.set(id, { live: live as unknown as Live<never>, refs: 1 });
    return { ...live, release: () => drop(id) };
  };
  /* oxlint-enable anti-slop/no-chained-type-assertions */
};

import type { Engine } from "@syncmesh/engine";
import type { SQLChunk, SQLWrapper } from "drizzle-orm";

import { Column, Param, SQL, StringChunk, Subquery, Table, getTableName, is } from "drizzle-orm";

import { replaceEqualDeep } from "./equal.js";
import { ROW_SYNC_TABLE } from "./sync-of.js";

/**
 * What a consumer reads, as one object whose **identity changes only when something changed** —
 * which is what lets `useSyncExternalStore` hold it without tearing, and what stops a component
 * re-rendering because an unrelated table was written.
 */
export interface LiveSnapshot<T> {
  /** Empty while pending, so a list never has to null-check. */
  readonly data: readonly T[];
  readonly status: "pending" | "error" | "success";
  /**
   * A local read has completed, and `data` is what it returned.
   *
   * The fact any empty-state claim rests on, and **not** the same fact as `status`. A query that
   * has never run has no answer to report, and a re-run that failed keeps the last good rows and
   * turns `status` to `error` without un-answering the question — so neither "not pending" nor
   * "is success" means the store has spoken. This does, it is on the snapshot rather than beside
   * it so it can never drift from the rows it describes, and once true it stays true.
   */
  readonly answered: boolean;
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
    else if (is(chunk, Column)) names.add(getTableName(chunk.table));
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
    else if (is(chunk, Column)) parts.push(`c:${getTableName(chunk.table)}.${chunk.name}`);
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
 * What a live query re-runs on: the two feeds a fold announces itself through, and nothing else.
 *
 * Narrower than `Engine` on purpose. A tab that holds no engine — because the origin's one engine
 * is in another tab's worker — can satisfy this with fold batches that arrived over a port, and
 * then every live query in the repository works there unchanged.
 */
export type LiveSource = Pick<Engine, "onFoldBatch" | "onAcknowledge">;

/**
 * A live query is a re-run on exact invalidation (D20 §4): the fold names the tables it touched.
 *
 * Two queries asking the same question share one subscription and one re-run, refcounted by
 * `release` — two components rendering the same list used to run the same SQL twice per fold.
 */
export const createLive = (engine: LiveSource) => {
  const shared = new Map<string, { readonly live: Live<never>; refs: number }>();

  const build = <T>(query: Runnable<T>): Live<T> => {
    const touched = tablesOf(query);
    // the row-sync table appears in raw SQL rather than as a Drizzle table, so the walk cannot
    // see it; the query's own text is what says whether a `syncOf` column was selected
    const sql = identityOf(query);
    const listeners = new Set<(rows: readonly T[]) => void>();
    let current: readonly T[] | undefined;
    let snap: LiveSnapshot<T> = {
      answered: false,
      data: EMPTY,
      error: undefined,
      status: "pending",
    };

    const run = async (): Promise<readonly T[]> => {
      let fresh: readonly T[];
      try {
        fresh = await query;
      } catch (cause) {
        const error = asError(cause);
        // a failed run keeps the last good rows: a transient error must not blank a list — and
        // it keeps `answered` too, because a read that fell over has told the caller nothing
        // about what is in the store, in either direction
        snap = { answered: snap.answered, data: snap.data, error, status: "error" };
        for (const listener of listeners) listener(snap.data);
        throw error;
      }
      // identity is the change decision, and every unchanged row keeps its reference
      const rows = current === undefined ? fresh : replaceEqualDeep(current, fresh);
      const changed = rows !== current || snap.status !== "success";
      current = rows;
      if (changed) {
        snap = { answered: true, data: rows, error: undefined, status: "success" };
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
    /**
     * An acknowledgement touches no row, so no fold names it — but it does change what a
     * `syncOf` column reads. Only a query that selected one subscribes, which is what makes
     * this opt-in per query: a report or a picker never re-runs on an ack at all.
     */
    const offAck = sql.includes(ROW_SYNC_TABLE) ? engine.onAcknowledge(schedule) : undefined;

    return {
      data: () => current,
      snapshot: () => snap,
      ready,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      release: () => {
        off();
        offAck?.();
      },
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

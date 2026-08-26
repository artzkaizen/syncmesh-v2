import type { Live, Runnable } from "@syncmesh/drizzle";

import { useEffect, useRef, useState } from "react";

import type { Keyed } from "./query-key.js";

import { queryKey } from "./query-key.js";

/** The slice of a mesh handle the hooks use: `mesh.on(...)`'s `live`. */
export interface LiveSource {
  readonly live: <T>(query: Runnable<T>) => Live<T>;
}

export interface LiveRows<T> {
  /** The rows as of the last run; `undefined` until the first run lands. */
  readonly rows: readonly T[] | undefined;
  readonly ready: boolean;
}

interface Held<T> {
  readonly key: string;
  readonly rows?: readonly T[];
}

/**
 * A live Drizzle query as React state: one subscription per distinct question, one render per
 * fold batch that changed the rows. Build the query inline — its `toSQL()` is the identity, so a
 * re-render with the same question reuses the subscription and a changed filter re-subscribes.
 *
 * ```ts
 * const { db, live } = handle;
 * const { rows } = useLiveQuery(handle, db.select().from(jobs).orderBy(jobs.id));
 * ```
 */
export function useLiveQuery<T>(handle: LiveSource, query: Runnable<T> & Keyed): LiveRows<T> {
  const key = queryKey(query);
  const current = useRef(query);
  current.current = query;
  const [held, setHeld] = useState<Held<T>>({ key });

  useEffect(() => {
    const live = handle.live(current.current);
    let open = true;
    const deliver = (rows: readonly T[]): void => {
      if (open) setHeld({ key, rows });
    };
    void live.ready.then(deliver);
    const off = live.subscribe(deliver);
    return () => {
      open = false;
      off();
      live.release();
    };
  }, [handle, key]);

  const rows = held.key === key ? held.rows : undefined;
  return { rows, ready: rows !== undefined };
}

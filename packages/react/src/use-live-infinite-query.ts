import type { Runnable } from "@syncmesh/drizzle";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Keyed } from "./query-key.js";
import type { LiveSource } from "./use-live-query.js";

import { queryKey } from "./query-key.js";

export interface InfiniteOptions<T, C> {
  /** One keyset window: the rows after `cursor`, at most `pageSize` of them, in a stable order. */
  readonly page: (after?: C) => Runnable<T> & Keyed;
  /** The cursor a row anchors — what `page` receives to fetch the window after it. */
  readonly cursorOf: (row: T) => C;
  readonly pageSize: number;
}

export interface InfiniteRows<T> {
  /** Every loaded window, in order; `undefined` until the first lands. */
  readonly rows: readonly T[] | undefined;
  readonly ready: boolean;
  /** The last window came back short: there is nothing after it. */
  readonly exhausted: boolean;
  /** Anchors the next window after the last loaded row; a no-op while loading or exhausted. */
  readonly loadMore: () => void;
}

/**
 * Keyset pagination over live windows — never offsets, which shift under live edits (D11).
 * Each loaded window stays live: a row entering or leaving any window re-renders once.
 */
export function useLiveInfiniteQuery<T, C>(
  handle: LiveSource,
  options: InfiniteOptions<T, C>,
): InfiniteRows<T> {
  const current = useRef(options);
  current.current = options;
  const [cursors, setCursors] = useState<readonly C[]>([]);
  const anchors = useMemo(() => [undefined, ...cursors], [cursors]);
  const key = anchors.map((after) => queryKey(current.current.page(after))).join("\n");
  const [held, setHeld] = useState<{ key: string; pages: readonly (readonly T[] | undefined)[] }>({
    key,
    pages: [],
  });

  useEffect(() => {
    const lives = anchors.map((after) => handle.live(current.current.page(after)));
    let open = true;
    const deliver = (index: number) => (rows: readonly T[]) => {
      if (!open) return;
      setHeld((previous) => {
        const pages = [...(previous.key === key ? previous.pages : [])];
        pages[index] = rows;
        return { key, pages };
      });
    };
    const offs = lives.map((live, index) => {
      void live.ready.then(deliver(index));
      return live.subscribe(deliver(index));
    });
    return () => {
      open = false;
      for (const off of offs) off();
      for (const live of lives) live.release();
    };
  }, [handle, key, anchors]);

  const pages = held.key === key ? held.pages : [];
  const loaded = pages.filter((page): page is readonly T[] => page !== undefined);
  const ready = loaded.length === anchors.length;
  const last = loaded.at(-1);
  const exhausted = ready && last !== undefined && last.length < current.current.pageSize;

  const loadMore = useCallback(() => {
    if (!ready || exhausted) return;
    const tail = last?.at(-1);
    if (tail === undefined) return;
    const anchor = current.current.cursorOf(tail);
    setCursors((held0) => [...held0, anchor]);
  }, [ready, exhausted, last]);

  return { rows: ready ? loaded.flat() : undefined, ready, exhausted, loadMore };
}

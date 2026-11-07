import type { Live, LiveListener, LiveSnapshot, Runnable } from "@syncmesh/drizzle";
import type { JsonValue, Row } from "@syncmesh/kernel";
import type { WindowClient } from "@syncmesh/window";

import { driverValues, keyOfRows } from "@syncmesh/drizzle";
import { ReadRefused } from "@syncmesh/window";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- `input` is the call's own argument, which the server's copy of the procedure parses; a row is rebuilt into the shape the handler's own query declares */

const PENDING: LiveSnapshot<never> = {
  answered: false,
  data: [],
  status: "pending",
  error: undefined,
};
const NONE: ReadonlyMap<string, never> = new Map<string, never>();

/** A live read that cannot open, as the snapshot `useLiveQuery` reports and a `ready` that rejects. */
export const failedLive = <T>(error: Error): Live<T> => {
  const ready = Promise.reject(error);
  ready.catch(() => undefined);
  const snapshot = { answered: false, data: [], status: "error", error } as const;
  return {
    data: () => undefined,
    snapshot: () => snapshot,
    ready,
    subscribe: () => () => undefined,
    release: () => undefined,
  };
};

interface Shared {
  readonly live: Live<unknown>;
  count: number;
}

/**
 * The reads of `sync: "window"` tables, as live queries over the socket the server serves pages
 * on (D39). Each distinct call is one window, shared by every subscriber holding the same call,
 * and closed when the last of them lets go.
 *
 * The rows are the handler's own: the server runs the same procedure against Postgres and
 * sends each row as its columns' driver values, and this maps them back through the same
 * query's columns, so a screen gets exactly the `T` a local read of the procedure returns.
 */
export function servedLives(windows: WindowClient) {
  const open = new Map<string, Shared>();

  const create = <T>(id: string, path: string, input: unknown, query: Runnable<T>): Live<T> => {
    const { fromDriver } = driverValues(query);
    const keyOf = keyOfRows(query) ?? ((row: T) => JSON.stringify(row));
    /** One object per row value, so a row that did not change keeps its identity across patches. */
    const built = new WeakMap<Row, T>();
    const listeners = new Set<LiveListener<T>>();
    let snapshot: LiveSnapshot<T> = PENDING;
    let settle:
      | { resolve: (rows: readonly T[]) => void; reject: (error: Error) => void }
      | undefined;
    const ready = new Promise<readonly T[]>((resolve, reject) => {
      settle = { resolve, reject };
    });
    ready.catch(() => undefined);

    const rowOf = (row: Row): T => {
      const found = built.get(row);
      if (found !== undefined) return found;
      // SAFETY: the server sent the fields this same query selects, each as its column's driver
      // value, and `fromDriver` maps each back through that column
      const made = fromDriver(Object.fromEntries(row)) as T;
      built.set(row, made);
      return made;
    };

    const update = (): void => {
      const reason = windows.refusal(id);
      if (reason !== undefined && !snapshot.answered) {
        const error = new ReadRefused({ message: `${path}: ${reason}` });
        snapshot = { answered: false, data: [], status: "error", error };
        settle?.reject(error);
        for (const listener of listeners) listener([]);
        return;
      }
      if (!windows.arrived(id)) return;
      const data = windows.rows(id).map((r) => rowOf(r.row));
      const before = snapshot.answered ? snapshot.state : NONE;
      if (
        snapshot.answered &&
        data.length === snapshot.data.length &&
        data.every((row, i) => row === snapshot.data[i])
      )
        return;
      const state = new Map(data.map((row) => [keyOf(row), row]));
      const added = new Map([...state].filter(([key]) => !before.has(key)));
      const changed = new Map(
        [...state].filter(([key, row]) => before.has(key) && before.get(key) !== row),
      );
      const removed = new Map([...before].filter(([key]) => !state.has(key)));
      snapshot = {
        answered: true,
        data,
        state,
        diff: { added, removed, changed },
        status: "success",
        error: undefined,
      };
      settle?.resolve(data);
      for (const listener of listeners) listener(data);
    };

    const off = windows.subscribe(update);
    // SAFETY: an input is JSON by the time it crosses: it is what the app called the procedure with
    windows.open(id, { path, input: JSON.parse(JSON.stringify(input ?? null)) as JsonValue });
    update();
    return {
      data: () => (snapshot.answered ? snapshot.data : undefined),
      snapshot: () => snapshot,
      ready,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      release: () => {
        off();
        windows.close(id);
      },
    };
  };

  return {
    /** The live rows of `path` called with `input`; `query` is the handler's query, built here only to read its shape. */
    live: <T>(path: string, input: unknown, query: Runnable<T>): Live<T> => {
      const id = JSON.stringify([path, input ?? null]);
      const shared = open.get(id) ?? { live: create(id, path, input, query), count: 0 };
      open.set(id, shared);
      shared.count++;
      // SAFETY: one id is one path and one input, so one handler and one row type
      const live = shared.live as Live<T>;
      let released = false;
      return {
        ...live,
        release: () => {
          if (released) return;
          released = true;
          shared.count--;
          if (shared.count > 0) return;
          open.delete(id);
          live.release();
        },
      };
    },
  };
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

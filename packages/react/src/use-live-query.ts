import type { Live } from "@syncmesh/drizzle";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

/**
 * The slice of a bound call these hooks need. `@syncmesh/orpc`'s `QueryCall` satisfies it
 * structurally and is not imported: the same reason `@syncmesh/ble` takes a `BleRadio` rather
 * than the module that supplies one — a test can drive this hook with three functions.
 */
export interface LiveCall<T> {
  /** Identity. Two renders that ask the same question share one subscription; a changed input re-subscribes. */
  readonly key: string;
  readonly live: () => Live<T>;
  readonly settled: () => Promise<void>;
}

/** React Query's names, minus what a live query makes meaningless (D26). */
export interface LiveResult<T> {
  /** The rows as of the last run; empty while pending, so a list never has to null-check. */
  readonly data: readonly T[];
  readonly status: "pending" | "error" | "success";
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly isSuccess: boolean;
  /**
   * Every source that could still fill this scope has answered. What separates "there are no
   * books" from "the relay has not replied yet" — the question React Query has no word for,
   * because HTTP has no second source to wait on.
   */
  readonly isSettled: boolean;
  readonly error: Error | undefined;
}

const EMPTY: readonly never[] = [];

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/**
 * A procedure's read as React state: one subscription per distinct question, one render per fold
 * batch that changed the rows — whether the change came from this device, another device over
 * BLE, or the relay.
 *
 * `useSyncExternalStore` over the query's own cached snapshot, so a concurrent render can never
 * tear and an unrelated table's fold costs no render at all: the snapshot keeps its identity
 * unless the rows actually changed, and unchanged rows keep theirs inside it.
 *
 * There is no provider and nothing to thread: `api` is already bound to its mesh, so the
 * descriptor carries everything the subscription needs.
 *
 * ```tsx
 * const { data, isPending, isSettled } = useLiveQuery(api.books.list({ page: 1 }));
 * if (isPending) return <Spinner />;
 * if (data.length === 0) return isSettled ? <NoBooks /> : <StillSyncing />;
 * ```
 */
export function useLiveQuery<T>(call: LiveCall<T>): LiveResult<T> {
  const { key } = call;
  const current = useRef(call);
  current.current = call;

  // building the query runs the input schema: a refusal is this render's error, not a throw
  const opened = useMemo((): Live<T> | Error => {
    try {
      return current.current.live();
    } catch (cause) {
      return asError(cause);
    }
  }, [key]);

  useEffect(() => {
    if (opened instanceof Error) return;
    return () => opened.release();
  }, [opened]);

  const failed = useMemo(
    () =>
      opened instanceof Error
        ? ({ data: EMPTY, status: "error", error: opened } as const)
        : undefined,
    [opened],
  );
  const subscribe = useCallback(
    (notify: () => void) => (opened instanceof Error ? () => undefined : opened.subscribe(notify)),
    [opened],
  );
  const read = useCallback(
    () => failed ?? (opened instanceof Error ? undefined : opened.snapshot()),
    [opened, failed],
  );
  const snap = useSyncExternalStore(subscribe, read, read);

  const [settledFor, setSettledFor] = useState<string>();
  useEffect(() => {
    let open = true;
    void current.current.settled().then(
      () => {
        if (open) setSettledFor(key);
      },
      () => undefined,
    );
    return () => {
      open = false;
    };
  }, [key]);

  return useMemo(() => {
    const status = snap?.status ?? "pending";
    return {
      data: snap?.data ?? EMPTY,
      status,
      isPending: status === "pending",
      isError: status === "error",
      isSuccess: status === "success",
      isSettled: settledFor === key,
      error: snap?.error,
    };
  }, [snap, settledFor, key]);
}

import type { Live } from "@syncmesh/drizzle";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { Answered } from "./answered.js";

import { answeredFrom } from "./answered.js";

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

/**
 * React Query's `enabled`, for a query that *could* run and should not yet.
 *
 * There is no other option here and there is deliberately no dependency array: a descriptor's
 * `key` is the subscription's identity, so the only thing left for a caller to say is whether the
 * question should be put at all. `undefined` and `true` both mean run it.
 *
 * Why both this and passing no call is in {@link useQuery}'s own comment, which is where the
 * distinction bites.
 */
export interface QueryOptions {
  /**
   * Defaults to `true`. `false` is **exactly** what passing no call is: nothing is opened, nothing
   * is subscribed, and an open subscription from a previous render is released.
   *
   * Identical by construction rather than by agreement — `enabled: false` is turned into no call
   * on the first line of this hook, so there is one disabled path and not two that match today.
   */
  readonly enabled?: boolean;
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
   * **How far this question has been answered** — and the only fact that licenses an empty state.
   *
   * One ordered value rather than two booleans, because two booleans describe four states for a
   * three-state progression and the fourth one lies. It used to be `hasAnswered` beside
   * `isSettled`, and a device with no transport has `isSettled: true` **before the first read has
   * run** — sources answer nearest first, and with no far sources there is nothing to wait for.
   * A screen reading `isSettled` alone drew a confident "nothing here" over a store it had not
   * asked yet.
   *
   * They were never two subjects either. This device's storage *is* the first source, so
   * `isSettled` was about a set that contains what `hasAnswered` was about — a subset, not a
   * sibling, which is why no pair of names for them ever read correctly.
   *
   * - `"none"` — no read has completed. `data` is `[]` and carries **no information**; the only
   *   honest UI is a skeleton. On a phone this is the whole cold start, because the client is a
   *   value and the database opens underneath it.
   * - `"local"` — this device's storage answered and `data` is what it returned. Empty means *not
   *   on this device yet*, never *nothing exists*. Survives a failed re-run: the last good rows
   *   stand, and `status` carries the error.
   * - `"settled"` — the storage and every other source that could fill this scope have each
   *   finished a first pass. **Empty means empty**, and this is the only state where it does.
   *
   * `none → local → settled`, and a device with no transports skips the middle. Never backwards
   * within one subscription; a changed input is a new question and starts again at `"none"`.
   */
  readonly answered: Answered;
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
 * const { data, answered } = useLiveQuery(api.books.list({ page: 1 }));
 * if (answered === "none") return <Spinner />;
 * if (data.length === 0) return answered === "settled" ? <NoBooks /> : <StillSyncing />;
 * ```
 *
 * A query can be held back two ways, and they collapse onto one path here: no call at all, or
 * `{ enabled: false }` beside a call that could have run. Either way `key` is `undefined`, so
 * nothing is opened and nothing is subscribed; flipping `enabled` back to `true` is a changed key
 * and subscribes exactly as a changed filter does, without the component remounting.
 *
 * ```tsx
 * // the poll is paused, not gone: the descriptor is still the identity when it resumes
 * const { data } = useLiveQuery(api.books.list({ page }), { enabled: tabVisible });
 * ```
 */
export function useLiveQuery<T>(
  call: LiveCall<T> | undefined,
  options?: QueryOptions,
): LiveResult<T> {
  // one disabled path: `enabled: false` *is* the no-call case from here down
  const asked = options?.enabled === false ? undefined : call;
  const key = asked?.key;
  const current = useRef(asked);
  current.current = asked;

  // building the query runs the input schema: a refusal is this render's error, not a throw;
  // no call at all — the conditional-query case — opens nothing and subscribes to nothing
  const opened = useMemo((): Live<T> | Error | undefined => {
    if (key === undefined) return undefined;
    try {
      const live = current.current?.live();
      // a read that threw is already on the snapshot, where this hook reports it; without this
      // the same news is also an unhandled rejection, which is a crash report for a handled error
      live?.ready.catch(() => undefined);
      return live;
    } catch (cause) {
      return asError(cause);
    }
  }, [key]);

  useEffect(() => {
    if (opened instanceof Error || opened === undefined) return;
    return () => opened.release();
  }, [opened]);

  const failed = useMemo(
    () =>
      opened instanceof Error
        ? ({ answered: false, data: EMPTY, status: "error", error: opened } as const)
        : undefined,
    [opened],
  );
  const subscribe = useCallback(
    (notify: () => void) =>
      opened instanceof Error || opened === undefined ? () => undefined : opened.subscribe(notify),
    [opened],
  );
  const read = useCallback(
    () =>
      failed ?? (opened instanceof Error || opened === undefined ? undefined : opened.snapshot()),
    [opened, failed],
  );
  const snap = useSyncExternalStore(subscribe, read, read);

  const [settledFor, setSettledFor] = useState<string>();
  useEffect(() => {
    if (key === undefined) return undefined;
    let open = true;
    void current.current?.settled().then(
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
      answered: answeredFrom(snap?.answered ?? false, key !== undefined && settledFor === key),
      error: snap?.error,
    };
  }, [snap, settledFor, key]);
}

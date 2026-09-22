import type { ReadCoverage } from "@syncmesh/client";

import { useMemo } from "react";

import type { Answered } from "./answered.js";
import type { LiveCall, QueryOptions } from "./use-live-query.js";

import { LOCAL_ONLY, useLiveQuery } from "./use-live-query.js";

/** TanStack Query's dialect, plus the one word HTTP-born libraries cannot have (book ch. 9). */
export interface QueryResult<T> {
  /** `undefined` until the local query stabilizes, then the rows. */
  readonly data: readonly T[] | undefined;
  readonly status: "pending" | "error" | "success" | "disabled";
  /**
   * **How far this question has been answered** — `"none"`, `"local"` or `"settled"`.
   *
   * This was `isReady` beside a `coverage` union: four states for a three-state fact, and the
   * fourth is the one that draws a confident empty screen over a store nobody asked. See
   * {@link Answered}; `useLiveQuery` reports the identical field, computed the same way.
   *
   * Taken from the snapshot's own answer rather than from `!isPending`, and the difference is the
   * whole of a false empty state: a read that threw is neither pending nor successful, so
   * `!isPending` would call it ready and hand back an empty `data` it never got from the store.
   *
   * A disabled query is `"none"` — it asked nothing, so nothing has answered.
   */
  readonly answered: Answered;
  /**
   * How much of the **world** has answered, and to which source's checkpoint (book ch. 9).
   *
   * Not the fourth readiness state the comment above rejects — `answered` is still the only
   * progression a screen walks. This is the other fact beside it, with a *name* on it: a query
   * over an empty local store is `answered: "local"` at once while coverage is still
   * `local-only`, and when it moves it says *which* source the rows are now good to. A disabled
   * query, and one over a device with no transports, reads `local-only` — the honest word for
   * "nothing here can say more".
   */
  readonly coverage: ReadCoverage;
  readonly isEnabled: boolean;
  readonly error: Error | undefined;
}

/**
 * The book's `useQuery`: conditional queries disable instead of crashing, no dependency array
 * ever (the descriptor's key *is* the identity), and one `answered` rather than a readiness flag
 * beside a coverage union — a query over an empty local store stabilizes instantly while the
 * relay has not yet spoken, and conflating those is how offline apps draw confident empty states.
 *
 * ```tsx
 * const { data, answered, isEnabled } = useQuery(
 *   shopId ? api.products.list({ shopId }) : undefined,
 * );
 * if (!isEnabled) return <PickAShop />;
 * if (answered === "none") return <Spinner />;
 * if (data.length === 0) return answered === "settled" ? <NoProducts /> : <StillSyncing />;
 * ```
 *
 * ## `enabled: false` and no call at all are both kept, and they are not two spellings of one thing
 *
 * The query is disabled when the call is `undefined` **or** `enabled` is `false`, and the two are
 * the same *state* — one disabled path, no subscription, the same result object. They are not the
 * same *situation*, and reaching for `enabled` everywhere because it is the familiar name is how
 * the difference gets lost.
 *
 * - **`enabled: false` means "I can build this descriptor and should not run it yet."** The input
 *   exists. A paused poll, a panel nobody has opened, a search box still inside its debounce —
 *   the question is well-formed and the answer is merely not wanted this render.
 * - **`undefined` means "there is no query."** The input does not exist, so the descriptor could
 *   not have been built honestly: with no `shopId` there is no `{ shopId }` to pass and
 *   `api.products.list()` does not type-check. The ternary in the example above is what makes an
 *   unconstructable descriptor *unrepresentable* rather than merely unexecuted.
 *
 * React Query has only the first of these, and pays for it. A query there is a key plus a
 * function, so `enabled: !!userId` still forces `queryKey: ['user', userId]` — a cache entry
 * keyed on `undefined`, standing for a question nobody can ask. Here the key comes off the
 * descriptor, and a descriptor that cannot be built has no key to invent. Adding `enabled` must
 * not quietly make `cond ? api.thing(input) : undefined` the old-fashioned style; it is the
 * better one wherever `input` only exists when `cond` does.
 *
 * ```tsx
 * // "there is no query": no shop, no descriptor, nothing to key on
 * useQuery(shopId ? api.products.list({ shopId }) : undefined);
 * // "not yet": the descriptor is complete and is being held back
 * useQuery(api.products.list({ shopId }), { enabled: isPanelOpen });
 * ```
 *
 * ## `enabled` is for not running, never for choosing
 *
 * Two hooks, one enabled and one not, so the caller can throw an answer away, is two
 * subscriptions and two results to reconcile. If both descriptors are constructible and yield the
 * same row, choose the *descriptor* and pass one call — `text === "" ? api.issues.list(…) :
 * api.issues.search({ text })` — which is one subscription, one result, and the condition stated
 * once. `apps/issues`'s `use-issues.ts` is the worked case.
 */
export function useQuery<T>(call: LiveCall<T> | undefined, options?: QueryOptions): QueryResult<T> {
  const live = useLiveQuery(call, options);
  const enabled = call !== undefined && options?.enabled !== false;

  return useMemo(() => {
    if (!enabled) {
      return {
        data: undefined,
        status: "disabled" as const,
        answered: "none" as const,
        coverage: LOCAL_ONLY,
        isEnabled: false,
        error: undefined,
      };
    }
    return {
      data: live.answered === "none" ? undefined : live.data,
      status: live.status,
      answered: live.answered,
      coverage: live.coverage,
      isEnabled: true,
      error: live.error,
    };
  }, [enabled, live]);
}

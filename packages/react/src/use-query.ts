import { useMemo } from "react";

import type { LiveCall, QueryOptions } from "./use-live-query.js";

import { useLiveQuery } from "./use-live-query.js";

/**
 * How much of the *world* a query's answer represents (book ch. 9). Today the machinery can
 * honestly say two things: nothing beyond this device has answered yet, or every source that
 * could still fill the scope finished its first pass. The per-source checkpoint variant grows
 * onto this union when signed checkpoints land — nothing here has to change shape.
 */
export type Coverage = { readonly kind: "local-only" } | { readonly kind: "caught-up" };

/** TanStack Query's dialect, plus the one word HTTP-born libraries cannot have (book ch. 9). */
export interface QueryResult<T> {
  /** `undefined` until the local query stabilizes, then the rows. */
  readonly data: readonly T[] | undefined;
  readonly status: "pending" | "error" | "success" | "disabled";
  /**
   * The **local** query stabilized — TanStack's word, kept with TanStack's meaning: this device's
   * store ran the read and `data` is its answer.
   *
   * Read off the snapshot's own `answered` rather than off `!isPending`, and the difference is
   * the whole of a false empty state. A read that threw is not pending and is not successful, so
   * `!isPending` calls it ready and hands a caller an empty `data` it never got from the store —
   * which is how a panel comes to say "not on this device" about a row the list beside it is
   * still drawing.
   */
  readonly isReady: boolean;
  readonly isEnabled: boolean;
  /** How much of the world has answered — deliberately a different fact from `isReady`. */
  readonly coverage: Coverage;
  readonly error: Error | undefined;
}

const LOCAL_ONLY: Coverage = { kind: "local-only" };
const CAUGHT_UP: Coverage = { kind: "caught-up" };

/**
 * The book's `useQuery`: conditional queries disable instead of crashing, no dependency array
 * ever (the descriptor's key *is* the identity), and `isReady`/`coverage` stay two facts — a
 * query over an empty local store stabilizes instantly while the relay has not yet spoken, and
 * conflating them is how offline apps draw confident empty states.
 *
 * ```tsx
 * const { data, isReady, isEnabled, coverage } = useQuery(
 *   shopId ? api.products.list({ shopId }) : undefined,
 * );
 * if (!isEnabled) return <PickAShop />;
 * if (!isReady) return <Spinner />;
 * if (data.length === 0)
 *   return coverage.kind === "caught-up" ? <NoProducts /> : <StillSyncing />;
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
        isReady: false,
        isEnabled: false,
        coverage: LOCAL_ONLY,
        error: undefined,
      };
    }
    return {
      data: live.hasAnswered ? live.data : undefined,
      status: live.status,
      isReady: live.hasAnswered,
      isEnabled: true,
      coverage: live.isSettled ? CAUGHT_UP : LOCAL_ONLY,
      error: live.error,
    };
  }, [enabled, live]);
}

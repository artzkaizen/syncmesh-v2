import { useMemo } from "react";

import type { LiveCall } from "./use-live-query.js";

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
  /** The **local** query stabilized — TanStack's word, kept with TanStack's meaning. */
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
 */
export function useQuery<T>(call: LiveCall<T> | undefined): QueryResult<T> {
  const live = useLiveQuery(call);
  const enabled = call !== undefined;

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
      data: live.isPending ? undefined : live.data,
      status: live.status,
      isReady: !live.isPending,
      isEnabled: true,
      coverage: live.isSettled ? CAUGHT_UP : LOCAL_ONLY,
      error: live.error,
    };
  }, [enabled, live]);
}

import { useCallback, useSyncExternalStore } from "react";

/** The slice of a mesh the hook reads: `can`, and the grant stream that changes its answer. */
export interface CanSource<R> {
  readonly can: (what: `${string}.${string}`, row?: R) => boolean;
  readonly grants: {
    readonly onRegistered: (listener: (...args: never[]) => void) => () => void;
  };
}

/**
 * `mesh.can` as React state: re-evaluated when a grant registers — the moment an onboarding
 * grant lands, every gated button flips without a reload. The row, when the rule needs one,
 * comes from a live query, which re-renders on its own changes.
 */
export function useCan<R>(mesh: CanSource<R>, what: `${string}.${string}`, row?: R): boolean {
  const subscribe = useCallback((notify: () => void) => mesh.grants.onRegistered(notify), [mesh]);
  return useSyncExternalStore(subscribe, () => mesh.can(what, row));
}

import { useCallback, useSyncExternalStore } from "react";

/** Where a row's write has reached; `@syncmesh/orpc`'s `api.$sync` satisfies this structurally. */
export interface SyncSource {
  readonly at: (table: string, key: string) => SyncState | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

export type SyncState = "local" | "delivered" | "remote";

/**
 * Where one row's write has reached, as React state — `"local"` until a peer's cursors cover the
 * event, then `"delivered"`; `"remote"` for a row another peer wrote, where delivery is not this
 * device's question.
 *
 * ```tsx
 * <Row dimmed={useSyncOf(api.$sync, "observation", row.id) === "local"}>
 * ```
 *
 * Subscribed rather than read once, which is the whole point: a write made offline on Tuesday
 * syncs on Thursday, and a receipt that still says "waiting" is worse than no receipt at all.
 *
 * There is deliberately no `"rejected"`. A peer that quarantines an event holds its cursor below
 * it forever and never tells the author, so a refused write is indistinguishable from one still
 * in flight — a state for it would be a fact the system cannot observe.
 */
export function useSyncOf(source: SyncSource, table: string, key: string): SyncState | undefined {
  const subscribe = useCallback((notify: () => void) => source.subscribe(notify), [source]);
  const read = useCallback(() => source.at(table, key), [source, table, key]);
  return useSyncExternalStore(subscribe, read, read);
}

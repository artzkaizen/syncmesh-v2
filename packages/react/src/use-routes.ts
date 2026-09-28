import type { Route } from "@syncmesh/transport";

import { useCallback, useRef, useSyncExternalStore } from "react";

export interface RoutesSource {
  readonly $routes: {
    readonly all: () => readonly Route[];
    readonly onChange: (listener: () => void) => () => void;
  };
}

const same = (a: readonly Route[], b: readonly Route[]): boolean =>
  a.length === b.length &&
  a.every((route, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      other.to === route.to &&
      other.via === route.via &&
      other.hops === route.hops &&
      other.expiresAt.equals(route.expiresAt)
    );
  });

/**
 * Every destination this device knows a way to, and how far (book ch. 17): `to`, the next hop
 * `via`, and `hops`. An empty list is a dead zone — nothing here can reach an authority, a relay
 * or anything that serves a name — which is the honest answer rather than a hang.
 *
 * ```tsx
 * const authority = useRoutes().find((route) => route.to === "authority");
 * // "authority · 2 hops via 4a82…", or "no way to the authority from here"
 * ```
 */
export function useRoutes(client: RoutesSource): readonly Route[] {
  const source = client;
  const held = useRef<readonly Route[] | undefined>(undefined);
  const subscribe = useCallback((notify: () => void) => source.$routes.onChange(notify), [source]);
  const snapshot = useCallback(() => {
    const next = source.$routes.all();
    const previous = held.current;
    if (previous !== undefined && same(previous, next)) return previous;
    held.current = next;
    return next;
  }, [source]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

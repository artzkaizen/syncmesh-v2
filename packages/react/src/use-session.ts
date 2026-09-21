import type { AuthStatus } from "@syncmesh/client";

import { useCallback, useRef, useSyncExternalStore } from "react";

export interface SessionSource {
  readonly $auth: {
    readonly status: () => AuthStatus;
    readonly subscribe: (listener: () => void) => () => void;
  };
}

const same = (a: AuthStatus, b: AuthStatus): boolean =>
  a.principal?.account === b.principal?.account &&
  a.principal?.role === b.principal?.role &&
  (a.expiresAt === null
    ? b.expiresAt === null
    : b.expiresAt !== null && a.expiresAt.equals(b.expiresAt));

/**
 * Who is signed in on this device, and until when — `principal: null` when nobody is.
 *
 * The principal is what the issuer signed: an account, a role, and whatever claims it vouched
 * for. It is **not** an actor a screen chose; the demo tracker's "go in as Bo" is that app's own
 * picker over the top of this, and does not belong here.
 *
 * Re-renders on sign-in, sign-out and a refreshed session, and not otherwise.
 *
 * ```tsx
 * const { principal } = useSession();
 * if (principal === null) return <SignIn />;
 * ```
 */
export function useSession(client: SessionSource): AuthStatus {
  const source = client;
  const held = useRef<AuthStatus | undefined>(undefined);
  const subscribe = useCallback((notify: () => void) => source.$auth.subscribe(notify), [source]);
  const snapshot = useCallback(() => {
    const next = source.$auth.status();
    const previous = held.current;
    if (previous !== undefined && same(previous, next)) return previous;
    held.current = next;
    return next;
  }, [source]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

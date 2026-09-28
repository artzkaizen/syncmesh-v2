import type { ReactNode } from "react";

import { useSyncExternalStore } from "react";

import type { LinksSource } from "./use-links.js";
import type { PeersSource } from "./use-peers.js";
import type { RoutesSource } from "./use-routes.js";
import type { SessionSource } from "./use-session.js";
import type { Reading, StatusSource } from "./use-status.js";

import { useLinkEvents } from "./use-links.js";
import { usePeers } from "./use-peers.js";
import { useRoutes } from "./use-routes.js";
import { useSession } from "./use-session.js";
import { useStatus } from "./use-status.js";

/**
 * The client, bound once, for every screen in an app.
 *
 * ```ts
 * // app/mesh.ts
 * export const mesh = syncmeshReact(createClient({ schema, procedures }));
 * ```
 * ```tsx
 * <mesh.Provider whileOpening={<Splash />}><App /></mesh.Provider>
 *
 * const { data } = useLiveQuery(mesh.api.issues.list({ shopId }));
 * const { health, sources } = mesh.useStatus();
 * ```
 *
 * **`api` is a property, not a hook**, and that is the whole design. A hook's one job is to
 * re-render a component when something outside React changes; the client is one object for the
 * life of the process, so a hook for it would be subscribing to nothing. What *does* change —
 * rows, health, who is reached, who is signed in — is behind a `use*`, each bound to this client
 * so a screen names nothing.
 *
 * The client may be a promise. On a phone, opening SQLite is I/O that must not stand between
 * launch and the first frame, so {@link SyncmeshReact.Provider} draws `whileOpening` until it has
 * answered and withholds the tree until then — which is exactly what makes `api` safe to read
 * as a property underneath it. Read *above* the provider, before the promise has settled, it
 * throws with a sentence rather than handing back `undefined`, because a module that reads the
 * client at import time is a wiring mistake and not a state to draw.
 *
 * **Deliberately not `use()` and not Suspense**, which is where this parts company with
 * LiveStore's `useStore`. Suspending stops the whole tree until the promise settles, and on a
 * phone that measured as ~500ms of nothing at all.
 */

/** Where the client is, from the factory's point of view. */
type Opening<C> =
  | { readonly kind: "opening" }
  | { readonly kind: "ready"; readonly client: C }
  | { readonly kind: "failed"; readonly error: Error };

const OPENING = { kind: "opening" } as const;

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/** What every bound hook needs of a client: the five `$` surfaces they read. */
export type Diagnosable = StatusSource & PeersSource & LinksSource & SessionSource & RoutesSource;

export interface ProviderProps {
  /** Drawn while a promised client has not answered. Nothing, by default: the tree is withheld. */
  readonly whileOpening?: ReactNode;
  /** Drawn when the promise rejected — no database, no key, whatever `createClient` refused for. */
  readonly whenUnavailable?: (error: Error) => ReactNode;
  readonly children?: ReactNode;
}

export interface SyncmeshReact<C extends Diagnosable> {
  /**
   * The client. Under {@link Provider} it is always there; above it, or before a promised client
   * has settled, reading this throws.
   */
  readonly api: C;
  /** Draws the tree once the client exists, and `whileOpening` until then. */
  readonly Provider: (props: ProviderProps) => ReactNode;
  readonly useStatus: () => Reading;
  readonly usePeers: () => ReturnType<typeof usePeers>;
  readonly useLinkEvents: (keep?: number) => ReturnType<typeof useLinkEvents>;
  readonly useSession: () => ReturnType<typeof useSession>;
  readonly useRoutes: () => ReturnType<typeof useRoutes>;
}

const isOpening = <C>(client: C | Promise<C>): client is Promise<C> => client instanceof Promise;

export function syncmeshReact<C extends Diagnosable>(client: C | Promise<C>): SyncmeshReact<C> {
  let current: Opening<C> = isOpening(client) ? OPENING : { kind: "ready", client };
  const listeners = new Set<() => void>();
  const settle = (next: Opening<C>): void => {
    current = next;
    for (const listener of listeners) listener();
  };
  // started here rather than in an effect, so the open overlaps React mounting instead of
  // queueing behind it — one process, one client, and nothing for an earlier start to leak into
  if (isOpening(client))
    void client.then(
      (ready) => settle({ kind: "ready", client: ready }),
      (cause: unknown) => settle({ kind: "failed", error: asError(cause) }),
    );

  const get = (): Opening<C> => current;
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };

  const ready = (): C => {
    if (current.kind === "ready") return current.client;
    throw new Error(
      current.kind === "opening"
        ? "the mesh has not opened yet — read `api` under <Provider>, not at module scope"
        : `the mesh could not open: ${current.error.message}`,
    );
  };

  const Provider = ({
    whileOpening = null,
    whenUnavailable,
    children,
  }: ProviderProps): ReactNode => {
    const opened = useSyncExternalStore(subscribe, get, get);
    if (opened.kind === "opening") return whileOpening;
    if (opened.kind === "failed") return whenUnavailable?.(opened.error) ?? null;
    return children;
  };

  return {
    get api() {
      return ready();
    },
    Provider,
    useLinkEvents: (keep) => useLinkEvents(ready(), keep),
    usePeers: () => usePeers(ready()),
    useRoutes: () => useRoutes(ready()),
    useSession: () => useSession(ready()),
    useStatus: () => useStatus(ready()),
  };
}

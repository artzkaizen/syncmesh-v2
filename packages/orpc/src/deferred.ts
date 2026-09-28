import type { MeshSchema } from "@syncmesh/client";
import type { Live, LiveListener, LiveSnapshot, Runnable } from "@syncmesh/drizzle";
import type { PresenceMap } from "@syncmesh/schema";

import type { ApiMesh } from "./api.js";

/**
 * The api before the mesh exists (book ch. 8).
 *
 * `createClient` hands back the client at once and opens the database underneath it, so every
 * surface here has to answer *before* there is a mesh to answer from. What each one says is the
 * same thing a query says while a read is out — pending, then the answer — rather than a throw
 * or an `undefined`, because a screen drawn on the first frame is going to ask.
 *
 * Only three things are deferred, and they are the three a descriptor hands out: the one-shot
 * read, the live subscription, and a subscription to the grant feed. Everything else on the api
 * either runs inside a write's own promise, where an `await ready` costs nothing, or is a
 * property a caller reads after `$ready`.
 */

/** A mesh that may not be there yet; `ApiMesh` itself is the case where it always is. */
export interface LazyApiMesh<PC extends PresenceMap = Record<string, never>> {
  readonly ready: Promise<void>;
  readonly current: () => ApiMesh<PC> | undefined;
  /** The manifest is an option, not a mesh product, so it is known before anything opens. */
  readonly schema: MeshSchema;
}

const SETTLED = Promise.resolve();

/** One shape inside `meshApi`, whichever the caller handed it. */
export const lazyOf = <PC extends PresenceMap>(
  source: ApiMesh<PC> | LazyApiMesh<PC>,
): LazyApiMesh<PC> =>
  "current" in source ? source : { current: () => source, ready: SETTLED, schema: source.schema };

export const notOpen = (): never => {
  throw new Error(
    "the mesh has not opened yet — await `client.$ready`, or read this under a provider that did",
  );
};

const EMPTY: readonly never[] = [];

const PENDING: LiveSnapshot<never> = {
  answered: false,
  data: EMPTY,
  error: undefined,
  status: "pending",
};

/**
 * A read that runs once the mesh is there. `getSQL` is the part only a live query reads, and a
 * live query is deferred on its own, so reaching it here before the mesh is the one wiring
 * mistake this does not paper over.
 */
export const deferredRunnable = <T>(
  ready: Promise<void>,
  build: () => Runnable<T>,
): Runnable<T> => ({
  getSQL: () => build().getSQL(),
  /* oxlint-disable-next-line unicorn/no-thenable -- `Runnable` *is* a thenable: a Drizzle query builder is awaited to run it, and this stands in for one until there is one */
  then: (onFulfilled, onRejected) => ready.then(() => build()).then(onFulfilled, onRejected),
});

/**
 * A live query that is pending until the mesh exists, and the real one from then on.
 *
 * The snapshot is one constant object until the inner query has spoken, so a `useSyncExternalStore`
 * over it draws once and holds — and the moment the inner query publishes, its listeners are
 * these listeners, so the first rows re-render exactly as a later fold would.
 */
export const deferredLive = <T>(
  lazy: Pick<LazyApiMesh, "current" | "ready">,
  open: () => Live<T>,
): Live<T> => {
  if (lazy.current() !== undefined) return open();
  const listeners = new Set<LiveListener<T>>();
  let inner: Live<T> | undefined;
  let released = false;
  const ready = lazy.ready.then(() => {
    if (released) return EMPTY;
    inner = open();
    inner.subscribe((rows, changes) => {
      for (const listener of listeners) listener(rows, changes);
    });
    return inner.ready;
  });
  // the same rejection reaches every reader through `snapshot().error`; unobserved here it would
  // also be a crash report for a handled failure
  ready.catch(() => undefined);
  return {
    data: () => inner?.data(),
    snapshot: () => inner?.snapshot() ?? PENDING,
    ready,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    release: () => {
      released = true;
      inner?.release();
    },
  };
};

/** A subscription taken now and attached when there is something to attach it to. */
export const deferredSubscribe = <PC extends PresenceMap>(
  lazy: LazyApiMesh<PC>,
  attach: (mesh: ApiMesh<PC>) => () => void,
): (() => void) => {
  const now = lazy.current();
  if (now !== undefined) return attach(now);
  let off: (() => void) | undefined;
  let gone = false;
  void lazy.ready.then(
    () => {
      const mesh = lazy.current();
      if (!gone && mesh !== undefined) off = attach(mesh);
    },
    () => undefined,
  );
  return () => {
    gone = true;
    off?.();
  };
};

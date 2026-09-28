/**
 * The leak counters behind `mesh.inspect.handles()` (book ch. 12): every live query, listener
 * and in-flight blob fetch the mesh has handed out and not yet seen released. A dropped
 * reference stays in the count instead of silently dying — the chaos epilogue asserts zeros.
 */
import type { Live, LiveQuery } from "@syncmesh/drizzle";
import type { SqlDialect } from "@syncmesh/storage";
import type { Transport } from "@syncmesh/transport";

import type { Blobs } from "./blobs.js";
import type { Handle, OpenHandle } from "./handles.js";

/** What still holds a seat, by kind. `operations` stays 0 until durable operation records land (Phase 1). */
export interface HandleCounts {
  /** Live queries currently held — `handle.live(query)` not yet released. */
  readonly observers: number;
  /** Listeners currently attached — `subscribe`/`onSyncChange`/`onTelemetry` not yet unsubscribed. */
  readonly subscriptions: number;
  /** Durable operation refs held open. */
  readonly operations: number;
  /** Blob fetches still in flight. */
  readonly fetches: number;
  /** Reachable `(transport, peer)` pairs right now — read from the radios, not tracked. */
  readonly links: number;
}

export interface Inspect {
  /** Live counts, cheap to call; all zeros (links aside) after a clean teardown. */
  readonly handles: () => HandleCounts;
}

/** A teardown that is also `Disposable`: call it, or `using` it — a second call is a no-op. */
export type Teardown = (() => void) & Disposable;

type TalliedKind = "observers" | "subscriptions" | "operations" | "fetches";

export interface HandleTally {
  /** Takes one seat of `kind`; the returned teardown gives it back exactly once. */
  readonly take: (kind: TalliedKind) => () => void;
  /** `take`, folded over a handle's own teardown: one idempotent, disposable release. */
  readonly wrap: (kind: TalliedKind, teardown: () => void) => Teardown;
  readonly counts: (links: number) => HandleCounts;
}

export function createHandleTally(): HandleTally {
  const held = { observers: 0, subscriptions: 0, operations: 0, fetches: 0 };

  const take: HandleTally["take"] = (kind) => {
    held[kind] += 1;
    let seated = true;
    return () => {
      if (!seated) return;
      seated = false;
      held[kind] -= 1;
    };
  };

  const wrap: HandleTally["wrap"] = (kind, teardown) => {
    const release = take(kind);
    // one guard over both: the wrapped teardown may not be idempotent itself (a refcount is not)
    let done = false;
    const once = (): void => {
      if (done) return;
      done = true;
      release();
      teardown();
    };
    return Object.assign(once, { [Symbol.dispose]: once });
  };

  return {
    take,
    wrap,
    counts: (links) => ({ ...held, links }),
  };
}

/**
 * The handle opener with every `live()` it hands out counted: the query takes an `observers`
 * seat until released, each of its listeners a `subscriptions` seat until unsubscribed. One
 * metered face per cached handle, so asking twice cannot double-wrap.
 */
export function meterHandles<D extends SqlDialect>(
  tally: HandleTally,
  open: OpenHandle<D>,
): OpenHandle<D> {
  const metered = new WeakMap<object, Handle<D>>();
  const meterLive = <T>(live: Live<T>): Live<T> => ({
    ...live,
    subscribe: (listener) => tally.wrap("subscriptions", live.subscribe(listener)),
    release: tally.wrap("observers", live.release),
  });
  return (instance, options) =>
    open(instance, options).map((handle) => {
      const held = metered.get(handle);
      if (held !== undefined) return held;
      const wrapped: Handle<D> = {
        ...handle,
        live: <T>(query: LiveQuery<T>) => meterLive(handle.live(query)),
      };
      metered.set(handle, wrapped);
      return wrapped;
    });
}

/** The blob surface with each fetch — buffered or streamed — holding a `fetches` seat while in flight. */
export function meterBlobs(tally: HandleTally, blobs: Blobs): Blobs {
  return {
    ...blobs,
    fetch: async (hash, options) => {
      const seated = tally.take("fetches");
      try {
        return await blobs.fetch(hash, options);
      } finally {
        seated();
      }
    },
    stream: (hash, options) => {
      const seated = tally.take("fetches");
      const reader = blobs.stream(hash, options).getReader();
      return new ReadableStream<Uint8Array>({
        start: async (controller) => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (cause) {
            controller.error(cause);
          } finally {
            seated(); // closed, errored or cancelled: the seat frees either way
          }
        },
        cancel: (reason) => reader.cancel(reason),
      });
    },
  };
}

/** Reachable `(transport, peer)` pairs right now — read live from the radios, never tracked. */
export function linksAcross(transports: readonly Transport[]): number {
  return transports.reduce((n, t) => n + (t.reaches?.().size ?? 0), 0);
}

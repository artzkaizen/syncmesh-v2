/**
 * The leak counters behind `mesh.inspect.handles()` (book ch. 12): every live query, listener
 * and in-flight blob fetch the mesh has handed out and not yet seen released. A dropped
 * reference stays in the count instead of silently dying — the chaos epilogue asserts zeros.
 */
import type { Live, LiveQuery } from "@syncmesh/drizzle";
import type {
  Engine,
  Inspector,
  InspectorOptions,
  PolicyWhy,
  SchemaReading,
  StoreFailure,
} from "@syncmesh/engine";
import type { PeerId, Row } from "@syncmesh/kernel";
import type { SqlDialect, SqlDriver } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { Transport } from "@syncmesh/transport";

import { createInspector } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { verifyLog } from "@syncmesh/storage";

import type { Blobs } from "./blobs.js";
import type { Handle, OpenHandle } from "./handles.js";
import type { MeshTelemetrySeam } from "./telemetry.js";

import { NoSuchCapability } from "./errors.js";

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
  /**
   * Checks the log's pages for damage an ordinary read cannot see (D39): `PRAGMA quick_check` on
   * a device's SQLite, `amcheck` on Postgres. O(log size), so it runs when asked and at boot after
   * an unclean shutdown, never on its own.
   *
   * Damage is a `StoreFailure` naming what the database reported. `NoSuchCapability` is a mesh
   * whose log offers no check: a bare event store, a runtime that refuses `PRAGMA`, a Postgres
   * without `amcheck`.
   *
   * @example
   * const verified = await mesh.inspect.verify();
   * if (verified.isErr()) console.error(verified.error.message);
   */
  readonly verify: () => Promise<Result<void, StoreFailure | NoSuchCapability>>;
  /** What this device can say about the builds around it ({@link Fleet}). */
  readonly fleet: Fleet;
  /**
   * `mesh.can`, with its reasons (U2): the same verdict, and the rung that gave it — on the policy
   * rung, which rule (the allow-block entry, and whether the instance's synced `_policy` doc or
   * the bundled manifest held it) and the leaves of it that decided. A reading: asking it changes
   * nothing and writes nothing.
   *
   * @example
   * const answer = mesh.inspect.why("notes.delete", row, "org:acme");
   * if (answer.rung === "policy" && !answer.allowed)
   *   console.log(answer.rule.entry, answer.because.map((step) => ruleText(step.node)));
   */
  readonly why: (what: `${string}.${string}`, row?: Row, instance?: string) => PolicyWhy;
  /**
   * The consumer the telemetry union was missing (D17, U2): one listener on this mesh's seam,
   * counting and timing every `engine.*` and `mesh.*` event by type, read back when asked.
   *
   * A tap, not a stream: it holds one subscription however often it is read, so a panel polls
   * `stats()` rather than adding a listener to the write path per repaint. It is counted under
   * `handles().subscriptions` until closed, and `using` closes it.
   *
   * @example
   * using tap = mesh.inspect.telemetry();
   * await doWork();
   * console.log(tap.report());
   */
  readonly telemetry: (options?: InspectorOptions) => TelemetryTap;
}

/** An {@link Inspector} fed by one mesh, holding one subscription until it is closed. */
export interface TelemetryTap extends Disposable {
  /** Everything seen since the tap opened or was last reset, busiest first. */
  readonly stats: Inspector["stats"];
  readonly of: Inspector["of"];
  readonly reset: Inspector["reset"];
  /** A few lines a person can read in a log or paste into an issue. */
  readonly report: Inspector["report"];
  /** Gives the subscription back; a second call is a no-op. */
  readonly close: () => void;
}

/**
 * The fleet as this device has seen it since boot (D31): which app schemas are still writing.
 * Never a gate — nothing refuses an event for its schema — but the number D31's rule waits on.
 */
export interface Fleet {
  /**
   * Per author, the lowest `schemaVersion` it was seen writing under (an event without one reads
   * as `1`) or announcing on its cursors frame, and when — within `within` of now, or since boot.
   *
   * Retire a table or column only once every author here reads at or above the version that
   * stopped writing it; an authority correcting a column added in version *n* reads here which
   * devices will fold the reason and not the value.
   *
   * @example
   * const below = [...mesh.inspect.fleet.oldestSchema({ within: Temporal.Duration.from({ days: 30 }) })]
   *   .filter(([, reading]) => reading.version < 4);
   */
  readonly oldestSchema: (options?: {
    readonly within?: Temporal.Duration;
  }) => ReadonlyMap<PeerId, SchemaReading>;
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
function linksAcross(transports: readonly Transport[]): number {
  return transports.reduce((n, t) => n + (t.reaches?.().size ?? 0), 0);
}

/**
 * `mesh.inspect.verify()` over the connection the log lives on: the storage check, with a log
 * that offers none answered as the capability it lacks.
 */
async function verifyStore(
  driver: SqlDriver | undefined,
): Promise<Result<void, StoreFailure | NoSuchCapability>> {
  const unavailable = (message: string) =>
    Result.err(new NoSuchCapability({ capability: "verify", message }));
  if (driver === undefined)
    return unavailable("this mesh runs over a bare event store, which has no pages to check");
  const verified = await verifyLog(driver);
  if (verified.isOk()) return Result.ok(undefined);
  const { error } = verified;
  return error._tag === "StoreFailure" ? Result.err(error) : unavailable(error.message);
}

/** What `mesh.inspect` reads: the tally, the radios, the log's connection and the engine. */
export interface InspectDeps {
  readonly tally: HandleTally;
  /** The radios, as the mesh runs them. */
  readonly links: { readonly list: () => readonly Transport[] };
  /** Where the log lives; `driver` is absent over a bare event store. */
  readonly booted: { readonly driver?: SqlDriver };
  readonly engine: Pick<Engine, "oldestSchema">;
  readonly now: () => Temporal.Instant;
  /** `mesh.can`'s question with its reasons, resolved the way `mesh.can` resolves it. */
  readonly why: Inspect["why"];
  /** The mesh's one telemetry seam, `engine.*` and `mesh.*` alike. */
  readonly telemetry: MeshTelemetrySeam["onTelemetry"];
}

/** One inspector on the mesh's seam, its subscription seated in the tally until closed. */
const openTap = (deps: InspectDeps, options: InspectorOptions | undefined): TelemetryTap => {
  const inspector = createInspector(options);
  const close = deps.tally.wrap("subscriptions", deps.telemetry(inspector.note));
  return {
    stats: inspector.stats,
    of: inspector.of,
    reset: inspector.reset,
    report: inspector.report,
    close,
    [Symbol.dispose]: close,
  };
};

/** `mesh.inspect`; a fleet window is judged against the mesh's own clock. */
export const createInspect = (deps: InspectDeps): Inspect => {
  const { tally, links, booted, engine, now } = deps;
  return {
    handles: () => tally.counts(linksAcross(links.list())),
    verify: () => verifyStore(booted.driver),
    fleet: {
      oldestSchema: ({ within } = {}) =>
        engine.oldestSchema(within === undefined ? undefined : { now: now(), within }),
    },
    why: deps.why,
    telemetry: (options) => openTap(deps, options),
  };
};

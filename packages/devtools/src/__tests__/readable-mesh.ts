import type { Mesh } from "@syncmesh/client";
import type { Engine } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Transport, TransportCondition } from "@syncmesh/transport";

import { NoSuchTransport } from "@syncmesh/client";
import { parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

/**
 * The fake is the point of this file.
 *
 * {@link ReadableMesh} is every member the source is allowed to touch and nothing else: no
 * `mutate`, no `receive`, no `recovery.run`, no `transports.add`, no `$recovery.export`. A source
 * that grew a call to one of those would fail every test here with a `TypeError` naming it, which
 * makes "read-only" something the suite checks rather than something a comment claims.
 *
 * The hubs count their listeners, because the cost argument for this whole design is that there
 * are a fixed few of them however many panels an app happens to install.
 */

/**
 * The listener one of these subscribe-shaped members takes, derived rather than restated — the
 * shape is "hand me a listener, take back a teardown", which every feed on the mesh answers to.
 */
export type Listener<F> = F extends (listener: infer L) => () => void ? L : never;

export interface ReadableMesh {
  readonly engine: Pick<
    Engine,
    | "peerId"
    | "onFoldBatch"
    | "onAcknowledge"
    | "onQuarantine"
    | "coverage"
    | "ahead"
    | "holding"
    | "acksAt"
    | "quarantine"
    | "recentEvents"
  >;
  /**
   * Loosened from `Teardown` to a plain function, because a fake need not be `Disposable` to be
   * subscribed to — and `Mesh` is still assignable to this, which is what the assertion needs.
   */
  readonly onTelemetry: (listener: Listener<Mesh["onTelemetry"]>) => () => void;
  readonly transports: Pick<Mesh["transports"], "list" | "onLinkEvent">;
  readonly routes: Pick<Mesh["routes"], "onChange" | "all">;
  readonly grants: Pick<
    Mesh["grants"],
    "all" | "expiring" | "grantFor" | "onRegistered" | "onForgotten"
  >;
  readonly auth: Pick<Mesh["auth"], "subscribe" | "principal" | "status">;
  readonly status: Pick<Mesh["status"], "get">;
  readonly peers: Pick<Mesh["peers"], "graph">;
  readonly inspect: Mesh["inspect"];
  readonly recovery: Pick<Mesh["recovery"], "list" | "explain" | "stranded">;
  readonly accounts: Pick<Mesh["accounts"], "disputes">;
  readonly schema: Mesh["schema"];
  readonly running: Mesh["running"];
  readonly settled: Mesh["settled"];
}

export const id = (hex: string): PeerId => parsePeerId(hex.repeat(64).slice(0, 64)).unwrap();
export const SELF = id("1");
export const NEAR = id("2");
export const THREE = parseSeqNum(3).unwrap();
export const SEVEN = parseSeqNum(7).unwrap();
export const AT = Temporal.Instant.fromEpochMilliseconds(1_726_000_000_000);

/** A hub that also says how many listeners it is holding, which is the thing under test. */
export const counted = <L extends (...args: never[]) => void>() => {
  const listeners = new Set<L>();
  return {
    live: () => listeners.size,
    emit: (...args: Parameters<L>) => {
      for (const listener of listeners) listener(...args);
    },
    subscribe: (listener: L) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};

export const medium = (name: string, watched: () => void): Transport => ({
  name,
  kind: "lan",
  priority: 2,
  maxLinks: () => 8,
  start: () => Promise.resolve(),
  whenReady: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  onStatus: () => {
    watched();
    return () => undefined;
  },
});

export const harness = () => {
  const folds = counted<Listener<Engine["onFoldBatch"]>>();
  const acks = counted<Listener<Engine["onAcknowledge"]>>();
  const parked = counted<Listener<Engine["onQuarantine"]>>();
  const telemetry = counted<Listener<Mesh["onTelemetry"]>>();
  const linkEvents = counted<Listener<Mesh["transports"]["onLinkEvent"]>>();
  const routes = counted<Listener<Mesh["routes"]["onChange"]>>();
  const registered = counted<Listener<Mesh["grants"]["onRegistered"]>>();
  const forgotten = counted<Listener<Mesh["grants"]["onForgotten"]>>();
  const auth = counted<Listener<Mesh["auth"]["subscribe"]>>();
  let watching = 0;
  const transports = [medium("lan", () => (watching += 1))];

  const fake: ReadableMesh = {
    engine: {
      peerId: SELF,
      onFoldBatch: folds.subscribe,
      onAcknowledge: acks.subscribe,
      onQuarantine: parked.subscribe,
      coverage: () => ({ synced: new Map([[NEAR, SEVEN]]), local: new Map() }),
      ahead: () => new Map(),
      holding: () => new Map(),
      acksAt: () => new Map([[NEAR, { cursors: new Map([[SELF, THREE]]), at: AT }]]),
      quarantine: () => [],
      recentEvents: () => Promise.resolve(Result.ok([])),
    },
    onTelemetry: telemetry.subscribe,
    transports: { list: () => transports, onLinkEvent: linkEvents.subscribe },
    routes: { onChange: routes.subscribe, all: () => [] },
    grants: {
      all: () => [],
      expiring: () => [],
      grantFor: () => undefined,
      onRegistered: registered.subscribe,
      onForgotten: forgotten.subscribe,
    },
    auth: {
      subscribe: auth.subscribe,
      principal: () => undefined,
      status: () => ({ principal: null, expiresAt: null }),
    },
    status: { get: () => ({ health: "local-ready", sources: new Map() }) },
    peers: { graph: () => ({ self: SELF, edges: [], silent: [] }) },
    inspect: {
      handles: () => ({ observers: 0, subscriptions: 0, operations: 0, fetches: 0, links: 0 }),
    },
    // the healthy answer, which is the one the audit almost always gives; a test that wants a
    // stranded run overrides this reader rather than teaching the harness to have rotated a key
    recovery: {
      list: () => [],
      explain: () => undefined,
      stranded: () => Promise.resolve(Result.ok([])),
    },
    accounts: { disputes: () => [] },
    schema: { entries: [], partitions: {}, sealedKinds: new Set<string>(), presence: [] },
    running: () => true,
    settled: () => Promise.resolve(),
  };

  return {
    folds,
    acks,
    parked,
    telemetry,
    linkEvents,
    routes,
    registered,
    forgotten,
    auth,
    watching: () => watching,
    // SAFETY: `ReadableMesh` is a `Pick` of `Mesh`, so every member here has the type the source
    // will find; what is missing is what the source is forbidden to reach for, and a test is the
    // only place that distinction can be enforced.
    mesh: fake as Mesh,
  };
};

/** Drains the microtask the coalescer scheduled, which is the whole of "one tick later". */
export const tick = () =>
  new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });

/**
 * The operator half, as a separate fake on purpose.
 *
 * {@link ReadableMesh} must not carry `force`: the point of that type is that a source which
 * reached for a mutator fails with a `TypeError` naming it. So the three members the *controls*
 * need are built here and composed in only by the tests that are about controls, which keeps the
 * read-only property checkable and still lets an inspector be driven end to end.
 */
export const forcing = () => {
  const held = new Map<string, TransportCondition>();
  return {
    list: () => [...held].map(([name, as]) => ({ name, as })),
    surface: {
      forced: () => [...held].map(([name, as]) => ({ name, as })),
      force: (name: string, as: TransportCondition) => {
        if (name !== "lan")
          return Promise.resolve(
            Result.err(new NoSuchTransport({ transport: name, message: "no such medium here" })),
          );
        held.set(name, as);
        return Promise.resolve(Result.ok(undefined));
      },
      release: (name: string) => {
        if (!held.delete(name))
          return Promise.resolve(
            Result.err(
              new NoSuchTransport({ transport: name, message: "nothing of that name is held" }),
            ),
          );
        return Promise.resolve(Result.ok(undefined));
      },
    },
  };
};

/** The readable fake with an operator surface bolted on, for the tests that drive one. */
export const withControls = (mesh: Mesh, over: ReturnType<typeof forcing>): Mesh => ({
  ...mesh,
  transports: { ...mesh.transports, ...over.surface },
});

/** The same fake, over a log that holds a run no key here can sign — a rotation, after the fact. */
export const withRecovery = (mesh: Mesh, stranded: Mesh["recovery"]["stranded"]): Mesh => ({
  ...mesh,
  recovery: { ...mesh.recovery, stranded },
});

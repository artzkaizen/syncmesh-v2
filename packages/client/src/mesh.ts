import type { Engine, EventStore, StateStore } from "@syncmesh/engine";
import type { EventId, PartitionKey, PeerId, Row as WireCells } from "@syncmesh/kernel";
import type { InvalidPartitionKey } from "@syncmesh/kernel";
import type { ColumnsMap, PartitionTree, Roles, Schema, Table, TablesOf } from "@syncmesh/schema";
import type { Transport, TransportContext } from "@syncmesh/transport";
import type { Grant, Identity } from "@syncmesh/wire";

import { can as canOn } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry } from "@syncmesh/wire";

import type { Booted, MeshOpenError } from "./boot.js";
import type { Collection } from "./collection.js";
import type { PlacementEntry } from "./context.js";
import type { DeliveredOptions } from "./delivered.js";
import type { MeshRevertError, TxError, UnknownPartitionKind, WriteError } from "./errors.js";
import type { QueryDescriptor } from "./query.js";
import type { LiveHandle } from "./registry.js";
import type { TxCollections } from "./tx.js";
import type { TxOptions, TxReceipt, View } from "./views.js";

import { openMeshEngine } from "./boot.js";
import { createContext } from "./context.js";
import { createDelivered } from "./delivered.js";
import { UnknownPartitionKind as UnknownKind } from "./errors.js";
import { createMeshGrants, type MeshGrants, type MeshGrantsOptions } from "./grants.js";
import { specOf } from "./query.js";
import { createQueryRegistry } from "./registry.js";
import { runTransports } from "./transports.js";
import { createView } from "./views.js";

export interface MeshOptions<P extends PartitionTree, RS extends Roles<P>, C extends ColumnsMap> {
  readonly schema: Schema<P, RS, C>;
  readonly identity: Identity;
  /** The peer whose signature grants must carry; absent, the mesh runs ungranted — schema checks only, no user tables. */
  readonly issuer?: PeerId;
  /**
   * The event log. Omitted, the platform's durable default is opened — one SQLite file per
   * identity under `dataDir` — and closed by `stop`. Memory is never a default: ask for it with
   * `createMemoryEventStore()`.
   */
  readonly store?: EventStore;
  /** Materialised rows, so boot is an open rather than a replay; needs `store`. The default store brings its own. */
  readonly stateStore?: StateStore;
  /** Where the default store's file goes. Default `.syncmesh`. */
  readonly dataDir?: string;
  readonly undoDepth?: number;
  /** Started at construction (D12); `add`/`remove` later is deliberately absent. */
  readonly transports?: readonly Transport[];
  /** An ungranted peer asked to exist on some link — forward it to your issuer, or answer with `grants.issue`. Untrusted. */
  readonly onGrantRequest?: TransportContext["onGrantRequest"];
  /** The peer whose events may write `global` tables — the relay's id, shipped in config like the issuer's. */
  readonly authority?: PeerId;
  /** The issuer's private half. Only the org's root of trust holds this; it unlocks `grants.issue`. */
  readonly issuerKey?: Identity;
  readonly now?: () => Temporal.Instant;
}

/** Instances by kind — `{ org: "acme", shelf: "s1" }` — that a scoped view writes and reads under. */
export type Pins = Readonly<Record<string, string>>;

/**
 * The collections and `tx` bound to pinned instances instead of the ambient ones: what a server
 * handling many tenants at once uses, one per call, with `activate` never involved.
 */
export type Scoped<C extends ColumnsMap> = {
  readonly [K in keyof C]: Collection<TablesOf<C>[K]>;
} & { readonly tx: MeshBase<C>["tx"] };

export interface MeshBase<C extends ColumnsMap> {
  readonly engine: Engine;
  readonly grants: MeshGrants;
  /** Sets the active instance of its kind; every collection of that kind re-points. */
  readonly activate: (instance: string) => Result<void, InvalidPartitionKey | UnknownPartitionKind>;
  readonly active: (kind: string) => PartitionKey | undefined;
  /** A view pinned to these instances; the same pins give the same view, so its live results share. */
  readonly scoped: (pins: Pins) => Result<Scoped<C>, InvalidPartitionKey | UnknownPartitionKind>;
  /** One event, one partition; refused before anything is written when the tables disagree. */
  readonly tx: (
    fn: (collections: TxCollections<C>) => Result<void, WriteError>,
    options?: TxOptions,
  ) => Promise<Result<TxReceipt, TxError>>;
  /**
   * Resolves once a peer is known — through a cursor exchange — to hold the event (or, with no
   * event, everything this device has synced so far). Delivery, not approval: every receiver
   * runs the same policy itself, and an authority's verdict is E12/E16's to add.
   */
  readonly delivered: (options?: DeliveredOptions) => Promise<void>;
  /** `"table.op"` against the same rules every receiver enforces. */
  readonly can: (what: `${string}.${string}`, row?: WireCells) => boolean;
  /** A maintained result for a `query` descriptor; identical descriptors share one. */
  readonly liveQuery: <T extends Table>(descriptor: QueryDescriptor<T>) => LiveHandle<T>;
  /** Drops the handle's hold on its maintained result; a handle not from `liveQuery` is a no-op. */
  readonly releaseQuery: <T extends Table>(handle: LiveHandle<T>) => void;
  readonly revert: (id: EventId) => Promise<Result<unknown, MeshRevertError>>;
  readonly canRevert: (id: EventId) => boolean;
  /** Open maintained query results; identical descriptors count once. */
  readonly openQueries: () => number;
  /** Every transport ready (or force-ready); rejects if one failed to start. */
  readonly ready: () => Promise<void>;
  /** Whether transports are running: true from construction until `stop`. */
  readonly running: () => boolean;
  /** Asks every connected peer for a grant for this device (flow A). */
  readonly requestGrant: (invite?: string) => void;
  /** Stops every transport, then closes the stores the mesh opened; a store you passed in stays yours. */
  readonly stop: () => Promise<void>;
}

export type Mesh<C extends ColumnsMap> = MeshBase<C> & {
  readonly [K in keyof C]: Collection<TablesOf<C>[K]>;
};

/**
 * One constructor: opens (or is given) the stores, boots the engine over them, and builds the
 * validator, grants and a collection per table, partitions ambient via `activate` (D07). Async
 * because boot is (D05): the clock must pass every stored stamp before a write is numbered.
 */
export async function createMesh<
  P extends PartitionTree,
  const RS extends Roles<P>,
  C extends ColumnsMap,
>(options: MeshOptions<P, RS, C>): Promise<Result<Mesh<C>, MeshOpenError>> {
  const { identity, issuer, issuerKey } = options;
  if (issuerKey !== undefined && issuerKey.peerId !== issuer)
    panic(
      "issuerKey does not match issuer: the private half must belong to the configured root of trust",
    );
  const now = options.now ?? (() => Temporal.Now.instant());
  const registry = createGrantRegistry({ issuer: issuer ?? identity.peerId, now });
  const grantsOptions = { now } satisfies MeshGrantsOptions;
  if (issuerKey !== undefined) Object.assign(grantsOptions, { issuerKey });
  const grants = createMeshGrants(registry, grantsOptions);
  const grantFor = (peer: PeerId): Grant | undefined => grants.grantFor(peer);
  // plain await, not Result.gen: a definition-time panic in `assemble` must reach the caller as itself
  const booted = await openMeshEngine({
    ...options,
    dataDir: options.dataDir ?? ".syncmesh",
    now,
    grantFor,
  });
  if (booted.isErr()) return booted;
  return Result.ok(assemble(options, { grants, grantFor, now, booted: booted.value }));
}

interface Assembled {
  readonly grants: MeshGrants;
  readonly grantFor: (peer: PeerId) => Grant | undefined;
  readonly now: () => Temporal.Instant;
  readonly booted: Booted;
}

/** Everything above the engine: the ambient view, scoped views, queries, transports, the namespace check. */
function assemble<P extends PartitionTree, RS extends Roles<P>, C extends ColumnsMap>(
  options: MeshOptions<P, RS, C>,
  deps: Assembled,
): Mesh<C> {
  const { schema, identity } = options;
  const { grants, grantFor, now, booted } = deps;
  const engine = booted.engine;
  const queries = createQueryRegistry(engine);
  const kinds = new Set(schema.kinds.map(String));
  const context = createContext({ kinds: [...kinds], peerId: identity.peerId, grantFor });

  const can: MeshBase<C>["can"] = (what, row) =>
    canOn(schema, grantFor(identity.peerId), what, row);

  const entryOf = new Map<string, PlacementEntry>(
    schema.entries.map((e) => [String(e.table.name), e]),
  );
  const entry = (name: string): PlacementEntry =>
    entryOf.get(name) ?? panic(`no schema entry for ${name}`);
  const viewDeps = {
    engine,
    tables: schema.tables,
    merge: schema.merge,
    can,
    log: booted.store.all,
    accountOf: (peer: PeerId) => grantFor(peer)?.account,
  };
  const ambient = createView({
    ...viewDeps,
    placementOf: (name) => context.placementFor(entry(name)),
  });

  const scopes = new Map<string, View>();
  const scoped: MeshBase<C>["scoped"] = (pins) =>
    Result.gen(function* () {
      const pinned = Object.entries(pins).sort(([a], [b]) => (a < b ? -1 : 1));
      const instances = new Map<string, PartitionKey>();
      for (const [kind, id] of pinned) {
        if (!kinds.has(kind))
          return Result.err(
            new UnknownKind({ kind, message: `the manifest declares no kind "${kind}"` }),
          );
        instances.set(kind, yield* parsePartitionKey(`${kind}:${id}`));
      }
      const scope = JSON.stringify(pinned);
      const view =
        scopes.get(scope) ??
        createView({
          ...viewDeps,
          scope,
          placementOf: (name) => context.placementIn(entry(name), instances),
        });
      scopes.set(scope, view);
      // SAFETY: one Collection per key of C plus `tx`, the same keys the ambient view was checked against
      return Result.ok({ ...view.collections, tx: view.tx } as Scoped<C>);
    });

  const releases = new WeakMap<object, () => void>();
  const liveQuery = <T extends Table>(descriptor: QueryDescriptor<T>): LiveHandle<T> => {
    const { table, options: listOptions, scope } = descriptor;
    const source = scope === undefined ? ambient : scopes.get(scope);
    const held =
      source?.collections[String(table.name)] ??
      panic(`no collection for ${String(table.name)}; the descriptor came from another mesh`);
    const handle = queries.acquire(table, specOf(listOptions), held.visible, scope);
    const limit = listOptions.limit;
    const live: LiveHandle<T> = {
      data: () => (limit === undefined ? handle.rows() : handle.rows().slice(0, limit)),
      subscribe: handle.subscribe,
    };
    releases.set(live, handle.release);
    return live;
  };

  const transportContext: TransportContext = { engine, identity, grants, now };
  if (options.onGrantRequest !== undefined)
    Object.assign(transportContext, { onGrantRequest: options.onGrantRequest });
  const links = runTransports(options.transports ?? [], transportContext);

  const base: MeshBase<C> = {
    engine,
    grants,
    activate: (instance) =>
      Result.gen(function* () {
        const key = yield* parsePartitionKey(instance);
        yield* context.activate(key);
        queries.rescanAll();
        return Result.ok(undefined);
      }),
    active: context.active,
    scoped,
    // SAFETY: the recorder is one Writes per table of C, the same keys the collections were built over
    tx: (fn, txOptions) => ambient.tx((recording) => fn(recording as TxCollections<C>), txOptions),
    can,
    delivered: createDelivered(engine, identity.peerId),
    liveQuery,
    releaseQuery: (handle) => releases.get(handle)?.(),
    revert: (id) => engine.revert(id),
    canRevert: (id) => engine.canRevert(id),
    openQueries: queries.size,
    ready: links.ready,
    running: links.running,
    requestGrant: links.requestGrant,
    stop: async () => {
      await links.stop();
      await booted.close();
    },
  };
  for (const name of Object.keys(ambient.collections))
    if (name in base) panic(`table "${name}" collides with a mesh method; rename the table`);
  // SAFETY: one Collection per key of C, and no key collides with MeshBase (checked above)
  return { ...base, ...ambient.collections } as Mesh<C>;
}

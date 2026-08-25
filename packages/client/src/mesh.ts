import type { Engine, EngineOptions, EventStore, ValidatorOptions } from "@syncmesh/engine";
import type { EventId, PartitionKey, PeerId, Procedure, Row as WireCells } from "@syncmesh/kernel";
import type { InvalidPartitionKey } from "@syncmesh/kernel";
import type { ColumnsMap, PartitionTree, Roles, Schema, Table, TablesOf } from "@syncmesh/schema";
import type { Transport, TransportContext } from "@syncmesh/transport";
import type { Grant, Identity } from "@syncmesh/wire";

import {
  can as canOn,
  createEngine,
  createMemoryEventStore,
  createValidator,
} from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry } from "@syncmesh/wire";

import type { Collection, Write, Writes } from "./collection.js";
import type { Placement, PlacementEntry } from "./context.js";
import type { DeliveredOptions } from "./delivered.js";
import type { MeshRevertError, TxError, UnknownPartitionKind, WriteError } from "./errors.js";
import type { Visible } from "./live-query.js";
import type { QueryDescriptor } from "./query.js";
import type { LiveHandle } from "./registry.js";
import type { TxCollections } from "./tx.js";

import { createCollection } from "./collection.js";
import { createContext } from "./context.js";
import { createDelivered } from "./delivered.js";
import { CrossPartitionTx } from "./errors.js";
import { createMeshGrants, type MeshGrants, type MeshGrantsOptions } from "./grants.js";
import { specOf } from "./query.js";
import { createQueryRegistry } from "./registry.js";
import { runTransports } from "./transports.js";

export interface MeshOptions<P extends PartitionTree, RS extends Roles<P>, C extends ColumnsMap> {
  readonly schema: Schema<P, RS, C>;
  readonly identity: Identity;
  /** The peer whose signature grants must carry; absent, the mesh runs ungranted — schema checks only, no user tables. */
  readonly issuer?: PeerId;
  readonly store?: EngineOptions["store"];
  readonly stateStore?: EngineOptions["stateStore"];
  readonly undoDepth?: number;
  readonly isAuthority?: boolean;
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

/** One committed `tx`: the event it appended, for `delivered` and `revert`. */
export interface TxReceipt {
  readonly eventId: EventId;
}

export interface MeshBase<C extends ColumnsMap> {
  readonly engine: Engine;
  readonly grants: MeshGrants;
  /** Sets the active instance of its kind; every collection of that kind re-points. */
  readonly activate: (instance: string) => Result<void, InvalidPartitionKey | UnknownPartitionKind>;
  readonly active: (kind: string) => PartitionKey | undefined;
  /** One event, one partition; refused before anything is written when the tables disagree. */
  readonly tx: (
    fn: (collections: TxCollections<C>) => Result<void, WriteError>,
  ) => Promise<Result<TxReceipt, TxError>>;
  /**
   * Resolves once a peer is known — through a cursor exchange — to hold the event (or, with no
   * event, everything this device has synced so far). Delivery, not approval: every receiver
   * runs the same policy itself, and an authority's verdict is E12/E16's to add.
   */
  readonly delivered: (options?: DeliveredOptions) => Promise<void>;
  /** `"table.op"` against the same rules every receiver enforces. */
  readonly can: (what: `${string}.${string}`, row?: WireCells) => boolean;
  /** A maintained result for a `list` descriptor; identical descriptors share one. */
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
  /** Stops every transport; the engine and its stores stay readable. */
  readonly stop: () => Promise<void>;
}

export type Mesh<C extends ColumnsMap> = MeshBase<C> & {
  readonly [K in keyof C]: Collection<TablesOf<C>[K]>;
};

type AnyCollection = Collection<Table> & {
  readonly writes: Writes<Table>;
  readonly visible: Visible;
};

/** One constructor: engine, validator, grants and a collection per table, partitions ambient via `activate` (D07). */
/** The engine as the manifest and options describe it, validator included. */
function buildEngine<P extends PartitionTree, RS extends Roles<P>, C extends ColumnsMap>(
  options: MeshOptions<P, RS, C>,
  grantFor: (peer: PeerId) => Grant | undefined,
  now: () => Temporal.Instant,
  store: EventStore,
): Engine {
  const { schema, identity, issuer, authority, isAuthority = false } = options;
  const validatorOptions = {
    schema,
    grantFor: issuer === undefined ? null : grantFor,
    isAuthority,
  } satisfies ValidatorOptions;
  if (authority !== undefined) Object.assign(validatorOptions, { authority });
  const engineOptions = {
    peerId: identity.peerId,
    clock: createHlcClock({ now }),
    store,
    merge: schema.merge,
    validate: createValidator(validatorOptions),
  } satisfies EngineOptions;
  if (options.stateStore !== undefined)
    Object.assign(engineOptions, { stateStore: options.stateStore });
  if (options.undoDepth !== undefined)
    Object.assign(engineOptions, { undoDepth: options.undoDepth });
  return createEngine(engineOptions);
}

export function createMesh<
  P extends PartitionTree,
  const RS extends Roles<P>,
  C extends ColumnsMap,
>(options: MeshOptions<P, RS, C>): Mesh<C> {
  const { schema, identity, issuer, issuerKey } = options;
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
  const store = options.store ?? createMemoryEventStore();
  const engine = buildEngine(options, grantFor, now, store);
  const queries = createQueryRegistry(engine);
  const context = createContext({
    kinds: schema.kinds.map(String),
    peerId: identity.peerId,
    grantFor,
  });

  const can: MeshBase<C>["can"] = (what, row) =>
    canOn(schema, grantFor(identity.peerId), what, row);

  const entryOf = new Map<string, PlacementEntry>(
    schema.entries.map((e) => [String(e.table.name), e]),
  );
  const placementOf = (name: string): Result<Placement, WriteError> => {
    const entry = entryOf.get(name);
    if (entry === undefined) return panic(`no schema entry for ${name}`);
    return context.placementFor(entry);
  };

  const collections: Record<string, AnyCollection> = {};
  for (const [name, table] of Object.entries(schema.tables)) {
    collections[name] = createCollection(table, {
      engine,
      placement: () => placementOf(name),
      can,
      log: store.all,
      merge: schema.merge,
      accountOf: (peer) => grantFor(peer)?.account,
    });
  }

  const releases = new WeakMap<object, () => void>();
  const liveQuery = <T extends Table>({ table, options }: QueryDescriptor<T>): LiveHandle<T> => {
    const held =
      collections[String(table.name)] ??
      panic(`no collection for ${String(table.name)}; the descriptor came from another schema`);
    const handle = queries.acquire(table, specOf(options), held.visible);
    const limit = options.limit;
    const live: LiveHandle<T> = {
      data: () => (limit === undefined ? handle.rows() : handle.rows().slice(0, limit)),
      subscribe: handle.subscribe,
    };
    releases.set(live, handle.release);
    return live;
  };

  const tx: MeshBase<C>["tx"] = (fn) =>
    Result.gen(async function* () {
      const writes: (Write & { readonly table: string })[] = [];
      const recording: Record<string, Writes<Table>> = {};
      for (const [name, c] of Object.entries(collections))
        recording[name] = tapWrites(c.writes, (write) => writes.push({ ...write, table: name }));
      // SAFETY: one recorder per table of C, built over the same keys as the collections
      yield* fn(recording as TxCollections<C>);
      const placements: Placement[] = [];
      for (const write of writes) placements.push(yield* placementOf(write.table));
      const distinct = [
        ...new Set(placements.map((p) => `${String(p.partition ?? "")}|${p.local === true}`)),
      ];
      if (distinct.length > 1) {
        return Result.err(
          new CrossPartitionTx({
            partitions: distinct,
            message: "a tx writes one partition; split it",
          }),
        );
      }
      const label = [...new Set(writes.map((w) => w.label))].join("+");
      const where = placements[0] ?? {};
      const event = yield* Result.await(
        engine.mutate(
          // SAFETY: `table.op` labels joined with `+`; procedure naming is the client's to define (E09)
          label as Procedure,
          (t) => {
            for (const write of writes) write.apply(t);
          },
          where,
        ),
      );
      return Result.ok({ eventId: event.id });
    });

  const delivered = createDelivered(engine, identity.peerId);

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
    tx,
    can,
    delivered,
    liveQuery,
    releaseQuery: (handle) => releases.get(handle)?.(),
    revert: (id) => engine.revert(id),
    canRevert: (id) => engine.canRevert(id),
    openQueries: queries.size,
    ready: links.ready,
    running: links.running,
    requestGrant: links.requestGrant,
    stop: links.stop,
  };
  for (const name of Object.keys(collections))
    if (name in base) panic(`table "${name}" collides with a mesh method; rename the table`);
  // SAFETY: one Collection per key of C, and no key collides with MeshBase (checked above)
  return { ...base, ...collections } as Mesh<C>;
}

const tapWrites = (writes: Writes<Table>, record: (write: Write) => void): Writes<Table> => ({
  create: (row) => writes.create(row).map(tap(record)),
  update: (key, patch) => writes.update(key, patch).map(tap(record)),
  delete: (key) => writes.delete(key).map(tap(record)),
});

const tap =
  (record: (write: Write) => void) =>
  (write: Write): Write => {
    record(write);
    return write;
  };

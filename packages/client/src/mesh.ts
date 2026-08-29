import type { MeshHandle } from "@syncmesh/drizzle";
import type { Engine, EventStore, Principal, StateStore } from "@syncmesh/engine";
import type { EventId, PeerId, RowKey, Row as WireCells, TableName } from "@syncmesh/kernel";
import type { InvalidPartitionKey } from "@syncmesh/kernel";
import type {
  AppValue,
  ColumnsMap,
  PartitionTree,
  PresenceMap,
  Roles,
  Schema,
  Table,
} from "@syncmesh/schema";
import type { BlobStore, SqlDialect, SqlDriver, Stores, TxReceipt } from "@syncmesh/storage";
import type { Transport, TransportContext } from "@syncmesh/transport";

import { parsePartitionKey } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";
import { memoryBlobStore } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createPresenceStore } from "@syncmesh/transport";
import { createGrantRegistry, type Identity } from "@syncmesh/wire";

import type { Blobs } from "./blobs.js";
import type { Booted, MeshOpenError } from "./boot.js";
import type { DeliveredOptions, ReceivedOptions } from "./delivered.js";
import type { Revision } from "./history.js";
import type { Topics } from "./presence.js";
import type { SyncState } from "./sync-state.js";

import { openAccounts, type MeshAccounts } from "./accounts.js";
import { createBlobs } from "./blobs.js";
import { openMeshEngine } from "./boot.js";
import { createCan } from "./can.js";
import { createDelivered, createReceived } from "./delivered.js";
import { createFlush } from "./flush.js";
import { openGrants, restoreGrants, type MeshGrants, type MeshGrantsOptions } from "./grants.js";
import { openHandles } from "./handles.js";
import { rowHistory } from "./history.js";
import { openInternal, type MeshInternal } from "./internal.js";
import { createPresence } from "./presence.js";
import { createSyncStates } from "./sync-state.js";
import { followTelemetry, type MeshTelemetrySeam } from "./telemetry.js";
import { runTransports } from "./transports.js";

export interface MeshOptions<
  P extends PartitionTree,
  RS extends Roles<P>,
  C extends ColumnsMap,
  D extends SqlDialect = "sqlite",
  PC extends PresenceMap = Record<string, never>,
> {
  readonly schema: Schema<P, RS, C, PC>;
  readonly identity: Identity;
  /** The peer whose signature grants must carry; absent, the mesh runs ungranted — schema checks only. */
  readonly issuer?: PeerId;
  /**
   * The event log alone — a mesh with no SQL tables and no `on()`. Omit both this and `driver`
   * and the platform's durable default is opened (one SQLite file per identity under `dataDir`)
   * and closed by `stop`. Memory is never a default: ask with `createMemoryEventStore()`.
   */
  readonly store?: EventStore;
  readonly stateStore?: StateStore;
  /**
   * Your own connection — SQLite on a device, Postgres on an authority: tables and capture are
   * installed on it, the log lives in it, and it stays yours to close. Its dialect decides
   * which Drizzle every handle speaks.
   */
  readonly driver?: SqlDriver & { readonly dialect?: D };
  /**
   * Stores someone else opened — what `scopedStores().storeFor(scope)` hands back (D07).
   *
   * This is how a device runs **one mesh per top-level instance, over one database each**: an
   * org's log, state and tables live in a file that holds nothing of any other org, so leaving
   * one is closing a mesh, `forget(scope)`, and deleting a file. A single mesh filtering one
   * shared log could only ever *approximate* that, and a filter bug there is a tenancy bug.
   *
   * They stay yours to close, like a `driver`. `stop()` leaves them open, because the set that
   * opened them is what knows when they are finished with.
   */
  readonly stores?: Stores;
  /** Where the default store's file goes. Default `.syncmesh`. */
  readonly dataDir?: string;
  readonly undoDepth?: number;
  /** Started at construction (D12); `add`/`remove` later is deliberately absent. */
  readonly transports?: readonly Transport[];
  /** An ungranted peer asked to exist on some link — forward it to your issuer, or answer with `grants.issue`. Untrusted. */
  readonly onGrantRequest?: TransportContext["onGrantRequest"];
  /** The peer whose events may write `global` tables — the relay's id, shipped in config like the issuer's. */
  readonly authority?: PeerId;
  /**
   * Where fetched bytes are cached (D18). Absent, an in-memory cache for the process; a
   * `sqlBlobStore` over your driver keeps them across restarts.
   */
  readonly blobStore?: BlobStore;
  /**
   * Postgres only: install row-level security compiled from the schema's `read` rules on boot,
   * so a handle's plain `db.select()` is already the caller's view — no `read()` wrapper at the
   * call site. The database role the app connects with must not be a superuser or BYPASSRLS,
   * or Postgres itself waves it through.
   */
  readonly rls?: boolean;
  /** The issuer's private half. Only the org's root of trust holds this; it unlocks `grants.issue`. */
  readonly issuerKey?: Identity;
  /**
   * Read `_links` rows where no grant is held, so `owner()` answers across a person's devices in
   * the two rungs that have no issuer (D21). Shipped config, set identically on every peer like
   * `issuer` and `authority` — never gated on holding {@link MeshOptions.accountKey}, or a
   * peer's verdict would depend on which keys it happens to carry and two peers would disagree
   * forever. Rollout is one-way: a peer with this off admits strictly more, never less.
   */
  readonly accounts?: boolean;
  /** The account's private half. Only a device vouching for itself holds this; it unlocks `accounts.link`. */
  readonly accountKey?: Identity;
  readonly now?: () => Temporal.Instant;
}

/** The data surface of one handle: Drizzle in, events out (D20), in the connection's dialect. */
export type Handle<D extends SqlDialect = "sqlite"> = MeshHandle<D>;

export interface OnOptions {
  /**
   * Act as this principal: `read()` sources admit only rows their `read` rule admits, and a
   * write their rules deny rejects the transaction before COMMIT. The events stay this device's.
   */
  readonly as?: Principal;
}

export interface HistoryOptions {
  /** Only this instance's writes count; omitted, the whole table. */
  readonly partition?: string;
}

/**
 * A revision at the string-named door: the table arrived as a name, so the columns are the
 * schema's, not the type system's.
 */
export type RevisionView = Omit<Revision<Table>, "changed" | "row"> & {
  /** What this write set; empty for a delete. */
  readonly changed: Readonly<Record<string, AppValue | undefined>>;
  /** The row as of this revision — the fold of every write up to it; `null` once deleted. */
  readonly row: Readonly<Record<string, AppValue | undefined>> | null;
};

export interface Mesh<
  D extends SqlDialect = "sqlite",
  PC extends PresenceMap = Record<string, never>,
> {
  readonly engine: Engine;
  readonly grants: MeshGrants;
  /**
   * The Drizzle surface pinned to an instance — `on("org:acme")` — or unpinned for global
   * tables; `{ as }` makes it act for a caller. The same pin and principal share one handle.
   */
  readonly on: (instance?: string, options?: OnOptions) => Result<Handle<D>, InvalidPartitionKey>;
  /** The row's writes oldest-first by stamp. A detail-view read: it scans the log. */
  readonly history: (
    table: string,
    key: string,
    options?: HistoryOptions,
  ) => Promise<Result<readonly RevisionView[], unknown>>;
  /**
   * The ephemeral tier pinned to an instance (D16) — `mesh.presence("board:b1").cursor.set(…)`.
   * Values are signed, conflated at every hop, and never touch the log.
   */
  readonly presence: (instance: string) => Topics<PC>;
  /**
   * What an authority overruled, and why (RFC-0014). An authority cannot reject a write — a
   * device that was offline would keep its value forever — so it overwrites with a reason, and
   * this is where a UI reads that reason to show "changed by the office, because …".
   */
  /** Corrections against this device's writes; the same object `internal.corrections` is. */
  readonly corrections: MeshInternal["corrections"];
  /**
   * Where a row's write has reached: `"local"`, `"delivered"`, or `"remote"` when another peer
   * wrote it (D26). What a UI renders per row instead of awaiting a promise from the call that
   * made it — a write made offline on Tuesday syncs on Thursday, long after that promise is gone.
   */
  readonly syncOf: (table: string, key: string) => SyncState | undefined;
  /** Bytes that never enter the log: content-addressed, verified at both ends (D18). */
  readonly blobs: Blobs;
  /**
   * Which devices an account has vouched for (D21), and where a link and a grant name different
   * accounts for one device. A link is an ordinary row, so there is nothing here to synchronise
   * or to persist — writing one and folding one are the same act every other row does.
   */
  readonly accounts: MeshAccounts;
  /**
   * `"table.op"` against the same rules every receiver enforces — the instance's synced `_policy`
   * doc when one has arrived, the bundled manifest when none has.
   *
   * Name the instance whenever the row has one. Rules deploy per instance (RFC-0008), so without
   * one there is nothing to look a doc up by: `user` tables answer for the account's own instance,
   * everything else falls back to the bundle, which is right until an authority publishes a doc
   * and stale from the moment it does.
   */
  readonly can: (what: `${string}.${string}`, row?: WireCells, instance?: string) => boolean;
  /** Resolves once a peer is known — through a cursor exchange — to hold the event (delivery, not approval). */
  readonly delivered: (options?: DeliveredOptions) => Promise<void>;
  /** Resolves once this device has folded the event — the inbound mirror of `delivered`. */
  readonly received: (options: ReceivedOptions) => Promise<void>;
  readonly revert: (id: EventId) => Promise<Result<unknown, unknown>>;
  readonly canRevert: (id: EventId) => boolean;
  /** The reserved tables, read through the engine's own folds rather than a second copy. */
  readonly internal: MeshInternal;
  /** Every transport's queue has run out; never rejects, never stops early (`createFlush`). */
  readonly flush: () => Promise<void>;
  /** One listener for `engine.*` and `mesh.*` alike (D17); a thrower never decides a write. */
  readonly onTelemetry: MeshTelemetrySeam["onTelemetry"];
  /** Every transport ready (or force-ready); rejects if one failed to start. */
  readonly ready: () => Promise<void>;
  /**
   * Every source that could still fill a scope has finished its first pass — what to await
   * before drawing an empty state (RFC-0019). Sources answer nearest first: this device's own
   * storage has already spoken by the time a mesh exists, then a relay, then a radio.
   */
  readonly settled: () => Promise<void>;
  readonly running: () => boolean;
  /** Asks every connected peer for a grant for this device (flow A). */
  readonly requestGrant: (invite?: string) => void;
  /** Stops every transport, then closes what the mesh opened; a store or driver you passed stays yours. */
  readonly stop: () => Promise<void>;
}

export type { TxReceipt };

/**
 * One constructor: opens (or is given) the stores, boots the engine over them, installs the
 * tables and capture, and hands out Drizzle handles per instance and principal. Async because
 * boot is (D05): the clock must pass every stored stamp before a write is numbered.
 */
export async function createMesh<
  P extends PartitionTree,
  const RS extends Roles<P>,
  C extends ColumnsMap,
  D extends SqlDialect = "sqlite",
  PC extends PresenceMap = Record<string, never>,
>(options: MeshOptions<P, RS, C, D, PC>): Promise<Result<Mesh<D, PC>, MeshOpenError>> {
  const { identity, issuer, issuerKey } = options;
  if (issuerKey !== undefined && issuerKey.peerId !== issuer)
    panic(
      "issuerKey does not match issuer: the private half must belong to the configured root of trust",
    );
  // the same shape one table over: a key whose feature is off signs rows this peer will never
  // read, and a mesh half-configured that way looks like one where links simply do not work
  if (options.accountKey !== undefined && options.accounts !== true)
    panic("accountKey does not match accounts: links are only read where `accounts: true` is set");
  const now = options.now ?? (() => Temporal.Now.instant());
  const registry = createGrantRegistry({ issuer: issuer ?? identity.peerId, now });
  const grantsOptions = { now } satisfies MeshGrantsOptions;
  if (issuerKey !== undefined) Object.assign(grantsOptions, { issuerKey });
  const { grants, bind } = openGrants(registry, grantsOptions);
  // plain await, not Result.gen: a definition-time panic in `assemble` must reach the caller as itself
  const booted = await openMeshEngine({
    ...options,
    dataDir: options.dataDir ?? ".syncmesh",
    now,
    grantFor: grants.grantFor,
  });
  if (booted.isErr()) return booted;
  bind(booted.value.engine);
  // after boot, because the grants live in the database boot opens; before any session, because
  // a peer that reconnects first would meet a device that had forgotten who everyone is
  const remembered = await restoreGrants(registry, booted.value.driver);
  if (remembered.isErr()) return remembered;
  return Result.ok(assemble(options, { grants, now, booted: booted.value }));
}

interface Assembled {
  readonly grants: MeshGrants;
  readonly now: () => Temporal.Instant;
  readonly booted: Booted;
}

function assemble<
  P extends PartitionTree,
  RS extends Roles<P>,
  C extends ColumnsMap,
  D extends SqlDialect,
  PC extends PresenceMap,
>(options: MeshOptions<P, RS, C, D, PC>, deps: Assembled): Mesh<D, PC> {
  const { schema, identity } = options;
  const { grants, now, booted } = deps;
  const { engine } = booted;
  const entryOf = new Map(schema.entries.map((e) => [String(e.table.name), e]));

  const on = openHandles<P, RS, C, D, PC>(schema, booted);
  const flush = createFlush({ transports: () => options.transports ?? [] });
  const internal = openInternal({ engine, self: identity.peerId });
  const syncStates = createSyncStates(engine, identity.peerId);

  const { accounts, accountOf, author } = openAccounts(options, { engine, grants, now });

  const history: Mesh<D, PC>["history"] = (table, key, historyOptions = {}) =>
    Result.gen(async function* () {
      const entry = entryOf.get(table) ?? panic(`the manifest has no table "${table}"`);
      const entries = yield* Result.await(booted.store.all());
      const partition =
        historyOptions.partition === undefined
          ? undefined
          : yield* parsePartitionKey(historyOptions.partition);
      // SAFETY: keys are opaque strings in the kernel
      const rowKey = key as never;
      const revisions = rowHistory(entry.table, rowKey, entries, {
        merge: schema.merge,
        partition,
        accountOf,
      });
      // SAFETY: the erased Table generic degenerates the cell types; every cell is an AppValue by construction
      return Result.ok(revisions as readonly RevisionView[]);
    });

  const presence = createPresence({
    identity,
    topics: schema.presence,
    store: createPresenceStore({ now, accountOf }),
    // every open session, and nowhere else: a value that cannot leave is dropped, not queued
    send: (wire) => links.sendPresence(wire),
    now,
  });
  const blobs = createBlobs({
    store: options.blobStore ?? memoryBlobStore(),
    transports: () => links.withBlobs(),
  });
  const transportContext: TransportContext = {
    engine,
    identity,
    grants,
    now,
    onPresence: (wire) => void presence.receive(wire),
  };
  if (options.onGrantRequest !== undefined)
    Object.assign(transportContext, { onGrantRequest: options.onGrantRequest });
  const links = runTransports(options.transports ?? [], transportContext);

  return {
    engine,
    grants,
    on,
    history,
    presence: (instance) => {
      const partition = parsePartitionKey(instance);
      if (partition.isErr()) panic(`presence: ${partition.error.message}`);
      return presence.at<PC>(partition.value);
    },
    blobs,
    accounts,
    corrections: internal.corrections,
    can: createCan({
      schema,
      engine,
      author,
      kindOf: (table) => entryOf.get(table)?.partition,
    }),
    delivered: createDelivered(engine, identity.peerId),
    syncOf: (table, key) =>
      // SAFETY: the brands name a table and a row key, which is exactly what a caller passes; they carry no invariant a string can fail
      syncStates.at(table as TableName, key as RowKey),
    received: createReceived(engine),
    revert: (id) => engine.revert(id),
    canRevert: (id) => engine.canRevert(id),
    internal,
    flush,
    onTelemetry: followTelemetry(engine),
    ready: links.ready,
    settled: links.settled,
    running: links.running,
    requestGrant: links.requestGrant,
    stop: async () => {
      syncStates.stop();
      presence.stop(); // an explicit departure, so peers see this device leave now
      // flush before the medium closes: the save at the end of a transport's queue is exactly
      // what a process exiting loses, and closing first would lose it every time
      await flush();
      await links.stop();
      await booted.close();
    },
  };
}

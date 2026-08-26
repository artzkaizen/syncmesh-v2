import type { Engine, EventStore, Principal, StateStore } from "@syncmesh/engine";
import type { EventId, PartitionKey, PeerId, Row as WireCells } from "@syncmesh/kernel";
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
import type { SqlDialect, SqlDriver, TxReceipt } from "@syncmesh/storage";
import type { Transport, TransportContext } from "@syncmesh/transport";
import type { Grant, Identity } from "@syncmesh/wire";

import { meshDrizzle, type MeshHandle } from "@syncmesh/drizzle";
import { can as canOn } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { createPresenceStore } from "@syncmesh/transport";
import { createGrantRegistry } from "@syncmesh/wire";

import type { Booted, MeshOpenError } from "./boot.js";
import type { DeliveredOptions, ReceivedOptions } from "./delivered.js";
import type { Revision } from "./history.js";
import type { Topics } from "./presence.js";

import { openMeshEngine } from "./boot.js";
import { createDelivered, createReceived } from "./delivered.js";
import { createMeshGrants, type MeshGrants, type MeshGrantsOptions } from "./grants.js";
import { rowHistory } from "./history.js";
import { createPresence } from "./presence.js";
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
   * Postgres only: install row-level security compiled from the schema's `read` rules on boot,
   * so a handle's plain `db.select()` is already the caller's view — no `read()` wrapper at the
   * call site. The database role the app connects with must not be a superuser or BYPASSRLS,
   * or Postgres itself waves it through.
   */
  readonly rls?: boolean;
  /** The issuer's private half. Only the org's root of trust holds this; it unlocks `grants.issue`. */
  readonly issuerKey?: Identity;
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
  /** `"table.op"` against the same rules every receiver enforces. */
  readonly can: (what: `${string}.${string}`, row?: WireCells) => boolean;
  /** Resolves once a peer is known — through a cursor exchange — to hold the event (delivery, not approval). */
  readonly delivered: (options?: DeliveredOptions) => Promise<void>;
  /** Resolves once this device has folded the event — the inbound mirror of `delivered`. */
  readonly received: (options: ReceivedOptions) => Promise<void>;
  readonly revert: (id: EventId) => Promise<Result<unknown, unknown>>;
  readonly canRevert: (id: EventId) => boolean;
  /** Every transport ready (or force-ready); rejects if one failed to start. */
  readonly ready: () => Promise<void>;
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

function assemble<
  P extends PartitionTree,
  RS extends Roles<P>,
  C extends ColumnsMap,
  D extends SqlDialect,
  PC extends PresenceMap,
>(options: MeshOptions<P, RS, C, D, PC>, deps: Assembled): Mesh<D, PC> {
  const { schema, identity } = options;
  const { grants, grantFor, now, booted } = deps;
  const { engine, validate } = booted;
  const entryOf = new Map(schema.entries.map((e) => [String(e.table.name), e]));

  const handles = new Map<string, Handle<D>>();
  const on: Mesh<D, PC>["on"] = (instance, onOptions = {}) => {
    // outside the generator: a missing connection is a setup mistake and must throw as itself
    const driver =
      booted.driver ??
      panic(
        "this mesh has no SQL connection: omit `store` for the durable default, or pass `driver`",
      );
    return Result.gen(function* () {
      const partition: PartitionKey | undefined =
        instance === undefined ? undefined : yield* parsePartitionKey(instance);
      const key = JSON.stringify([instance ?? null, onOptions.as ?? null]);
      const held = handles.get(key);
      if (held !== undefined) return Result.ok(held);
      // SAFETY: the booted driver is the one `options.driver` carried, whose dialect is D — or the SQLite default when none was given
      const typed = driver as SqlDriver & { readonly dialect?: D };
      const drizzleOptions = { engine, validate, driver: typed, schema };
      if (partition !== undefined) Object.assign(drizzleOptions, { partition });
      if (onOptions.as !== undefined) Object.assign(drizzleOptions, { as: onOptions.as });
      const handle = meshDrizzle<D>(drizzleOptions);
      handles.set(key, handle);
      return Result.ok(handle);
    });
  };

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
        accountOf: (peer) => grantFor(peer)?.account,
      });
      // SAFETY: the erased Table generic degenerates the cell types; every cell is an AppValue by construction
      return Result.ok(revisions as readonly RevisionView[]);
    });

  const presenceStore = createPresenceStore({ now, accountOf: (peer) => grantFor(peer)?.account });
  const presence = createPresence({
    identity,
    topics: schema.presence,
    store: presenceStore,
    // every open session, and nowhere else: a value that cannot leave is dropped, not queued
    send: (wire) => links.sendPresence(wire),
    now,
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
    can: (what, row) => canOn(schema, grantFor(identity.peerId), what, row),
    delivered: createDelivered(engine, identity.peerId),
    received: createReceived(engine),
    revert: (id) => engine.revert(id),
    canRevert: (id) => engine.canRevert(id),
    ready: links.ready,
    running: links.running,
    requestGrant: links.requestGrant,
    stop: async () => {
      presence.stop(); // an explicit departure, so peers see this device leave now
      await links.stop();
      await booted.close();
    },
  };
}

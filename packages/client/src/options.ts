import type { EngineError, EventStore, Narrowed, StateStore } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { ColumnsMap, PresenceMap, Schema } from "@syncmesh/schema";
import type {
  BlobStore,
  ScopedStoreSet,
  SqlDialect,
  SqlDriver,
  StoreScope,
  Stores,
  StrictCapture,
} from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { Transport, TransportContext } from "@syncmesh/transport";
import type { Entropy, Identity, PartitionKeys } from "@syncmesh/wire";

import type { SessionProvider } from "./auth.js";
import type { Knock, MeshShaping } from "./transports.js";

/**
 * Everything one mesh is constructed from — **grouped by the decision, not flattened into a bag.**
 *
 * Four groups, because there were always four decisions: where the data lives (`storage`), who is
 * trusted (`trust`), what the radios are (`transports`, `knocks`, `mesh`, `admission`), and who is
 * calling (`auth`). An app passes these to `createClient` from `@syncmesh/orpc`, which takes the
 * same shape with `identity` optional and `procedures` beside it.
 *
 * **No tenant, workspace or shop appears here.** Scope is input, never construction (book ch. 3);
 * a client is built once and every call says which replica it is about.
 */
export interface MeshOptions<
  C extends ColumnsMap,
  D extends SqlDialect = "sqlite",
  PC extends PresenceMap = Record<string, never>,
> {
  readonly schema: Schema<C, PC>;
  readonly identity: Identity;
  /**
   * Where this node's data lives: {@link sqlite}, or {@link postgres} for a node that materializes
   * into a database somebody else also reads. The platform's own SQLite when unasked.
   */
  readonly storage?: Storage & { readonly dialect: D };
  /**
   * Shipped config, identical on every peer: who signs grants, and whose writes may correct.
   *
   * **Never runtime-derived** — a peer whose verdict depended on which keys it happened to carry
   * would disagree with its own mesh forever.
   */
  readonly trust?: Trust;
  /**
   * Who the user is, and how to prove it (book ch. 14). Every handle then acts as that
   * principal by default, so a call site never names one — a device has one caller, and letting
   * a call site pick is how "acting as" bugs ship. Absent, the device acts as nobody in
   * particular and only the schema's structural checks apply.
   */
  readonly auth?: SessionProvider;
  /** Started at construction (D12); `transports.add/remove` reshape the set later (book ch. 8). */
  readonly transports?: readonly Transport[];
  /**
   * Whether the transports open at construction. Default `true`. With `false` the engine and
   * stores boot and nothing is dialled until `start()`; `transports.add` before then queues the
   * medium to open with the rest, and `ready()`/`settled()` wait for the start.
   */
  readonly start?: boolean;
  /**
   * The platform signals that mean *look at your links again* (see {@link Knock}) — an app
   * returning to the foreground, a network becoming reachable (`@syncmesh/react-native` ships both).
   *
   * Recovery is the library's job, not the app's: named once, the mesh subscribes for as long as
   * it runs and tells every medium to re-check its link when one of them fires. Absent — every
   * server, and any device where nothing sleeps — nothing subscribes and nothing changes.
   *
   * These are *signals*, not a policy. Each one only ever says "something outside changed"; what to
   * do about it belongs to the medium: the relay hangs up an orphaned socket and redials with its
   * backoff reset, the radio stops and restarts discovery.
   */
  readonly knocks?: readonly Knock[];
  /** Fleet shaping (book ch. 17): periodic re-peering, and what belongs to the room rather than a medium. */
  readonly mesh?: MeshShaping;
  /**
   * An **override only**: an ungranted peer asked to exist on some link. By default admission is
   * derived from grants — an overlapping grant, or a peer asking for one, else deny. This is for
   * the rule a deployment adds on top ("no BLE on site"), or forwarding the ask to an issuer, never
   * the rule that makes the default work. Untrusted input.
   */
  readonly admission?: TransportContext["onGrantRequest"];
  /**
   * A signed checkpoint to offer with any state this node serves (RFC-0019, book ch. 4).
   *
   * Read per call rather than held, because the thing it stands for moves: a certificate names a
   * `stateHash` and the coverage that produced it, so the newest one is the only one that matches
   * what this device would send now. Only a holder of the issuer key can mint one — but any node
   * may *forward* the one it was given, which is how state travels further than the authority
   * that vouched.
   */
  readonly certificate?: TransportContext["certificate"];
  /**
   * The engine's CSPRNG, for the one moment it is needed before any key exists: device keys and
   * handshake nonces. Defaults to `globalThis.crypto.getRandomValues`; pass `expo-crypto`'s on
   * React Native, where there is no global one.
   */
  readonly entropy?: Entropy;
  /**
   * This device was just told it may no longer read something it holds (D45): its own grant now
   * names fewer partitions, or the authority's gate re-paged it and withheld rows of these tables.
   * Runs before anything is removed — tell the person — and is awaited; a throw is warned about
   * and the purge goes ahead. Then the device drops those rows, the events of other devices that
   * wrote them, their doc logs, and the cached blobs only those rows named unless this device
   * made them. Its own writes are kept.
   *
   * Return promptly: a row narrowing found by a relay re-page waits on this hook inside that
   * relay session, so sync from it stalls until the hook settles. Show the notice and return;
   * do not wait for the person to dismiss it.
   *
   * Hygiene on an honest device, not a security boundary: a modified client keeps what it was
   * sent. A later widening brings the rows back by re-paging.
   */
  readonly onNarrowed?: (narrowed: Narrowed) => Promise<void> | void;
  /**
   * Everything the engine under this mesh reports, from before there is a mesh to report it on.
   *
   * `engine.onError` subscribes just as well for the life of the process, and for almost
   * everything that is the right door. This one exists for the reports that happen *while the
   * mesh opens*, which a caller cannot have subscribed to, because the call they would subscribe
   * through has not returned yet — and the report that matters most is exactly there.
   * `openEngine` audits the log for `StrandedWrites` while it opens, because opening a log under
   * a key that did not write all of it is the moment those writes become undeliverable and the
   * last moment anyone could still be told.
   *
   * A thrower is not contained here: this runs inside boot, and a listener that throws takes the
   * open down with it. Keep it to reporting.
   */
  readonly onError?: (error: EngineError) => void;
  readonly now?: () => Temporal.Instant;
  /**
   * How far ahead of this device's clock a peer's stamp may run and still be folded (D34).
   * Default five minutes. A stamp beyond it is parked, not dropped, and admitted on a retry once
   * the clock has caught up; the device's own clock is clamped to the same bound when it adopts a
   * remote one. Set identically on every peer, like every other rung of the ladder.
   */
  readonly clockDrift?: Temporal.Duration;
  readonly undoDepth?: number;
}

/** Who this mesh trusts, and the private halves only the peer that *is* one of them holds. */
export interface Trust {
  /** The peer whose signature grants must carry; absent, the mesh runs ungranted — schema checks only. */
  readonly issuer?: PeerId;
  /** The peer whose events may write `global` tables — shipped in config like the issuer's. */
  readonly authority?: PeerId;
  /** The issuer's private half. Only the org's root of trust holds this; it unlocks `grants.issue`. */
  readonly issuerKey?: Identity;
  /**
   * The issuer's content keys for sealed partitions (D40), the other secret only the issuer holds.
   * Given, every grant `grants.issue` and `grants.renew` mint carries the keys for the sealed
   * partitions it names, wrapped to its device, and `grants.rekey` rotates one. Persist its
   * `held()`: it is the only copy.
   */
  readonly partitionKeys?: PartitionKeys;
  /** The account's private half. Only a device vouching for itself holds this; it unlocks `accounts.link`. */
  readonly accountKey?: Identity;
  /**
   * Read `_links` rows where no grant is held, so `owner()` answers across a person's devices in
   * the two rungs that have no issuer (D21). Set identically on every peer like `issuer` and
   * `authority` — never gated on holding {@link Trust.accountKey}, or a peer's verdict would
   * depend on which keys it happens to carry and two peers would disagree forever. Rollout is
   * one-way: a peer with this off admits strictly more, never less.
   */
  readonly accounts?: boolean;
}

/**
 * Where a device's data lives, as one answer instead of seven fields.
 *
 * `dir` alone is the ordinary case: the platform opens its own SQLite there — OPFS-backed WASM in
 * a browser, a file under Bun and Node. Everything else on this type is an escape hatch for a
 * caller who has already opened something, and each stays **theirs to close**, which is the
 * property that makes one database per tenant possible (D07).
 */
export interface SqliteStorage {
  readonly dialect: "sqlite";
  /** Where the default store's file goes (one SQLite file per identity). Default `.syncmesh`. */
  readonly dir?: string;
  /** Your own connection: tables and capture are installed on it and it becomes the log too. */
  readonly driver?: SqlDriver;
  /**
   * Refuse a write to a synced table made outside a mesh write — raw SQL on the connection, an
   * ORM call outside `mesh.write` — rather than let the row change with no event to carry it
   * (gaps U5). Default `true`; `false`, or `{ except: [table] }` for the tables something else
   * writes. Applies where the mesh installs the tables: a `driver`, or the platform default.
   */
  readonly strict?: StrictCapture;
  /**
   * Stores someone else opened — what `scopedStores().storeFor(scope)` hands back (D07).
   *
   * This is how a device runs **one mesh per top-level instance, over one database each**: an
   * org's log, state and tables live in a file that holds nothing of any other org, so leaving
   * one is closing a mesh, `forget(scope)`, and deleting a file. They stay yours to close, like a
   * `driver`, because the set that opened them is what knows when they are finished with.
   */
  readonly stores?: Stores;
  /**
   * The set those `stores` came from, and how to delete one scope's files — what lets
   * `recovery.stores` shed a store this device no longer holds a grant for (book ch. 13).
   *
   * Absent, there is no sweep: a mesh over one driver has nothing to shed but itself. The
   * deletion is yours for the same reason the set is — only the caller knows where the files are.
   */
  readonly sweep?: {
    readonly set: ScopedStoreSet;
    readonly remove: (scope: StoreScope) => Promise<void>;
  };
  /**
   * The event log alone — a mesh with no SQL tables and no `on()`. Memory is never a default:
   * ask with `createMemoryEventStore()`.
   */
  readonly store?: EventStore;
  readonly stateStore?: StateStore;
  /** Where fetched bytes are cached (D18); absent, an in-memory cache for the process. */
  readonly blobs?: BlobStore;
}

/**
 * Postgres, for the node whose folded rows are somebody else's tables too.
 *
 * The same store as {@link SqliteStorage} in every way that matters to the engine — a log, the
 * rows it folds to, and the capture that turns a write into an event — and the difference is who
 * else is reading. The fold materializes *into your schema*, and a `SELECT` from a report, a cron
 * job or another service sees what the mesh agreed on without asking the mesh anything (book
 * ch. 18).
 *
 * **The driver is the dialect.** `postgresDriver` from `@syncmesh/postgres` carries
 * `dialect: "postgres"` and every layer below reads it off the connection, so a mismatch between
 * what a caller asked for and what they handed over is not representable.
 */
export interface PostgresStorage {
  readonly dialect: "postgres";
  /** The connection this node folds into — yours to open, and yours to close. */
  readonly driver: SqlDriver & { readonly dialect: "postgres" };
  /**
   * Compile the schema's `read` rules into the database's own row-level policies on boot.
   *
   * Belt and braces rather than the enforcement itself: every receiver already checks `allow` at
   * the fold, and this puts the same rules where a hand-written `SELECT` on the same connection
   * cannot get around them. The role the app connects with must not be a superuser or BYPASSRLS,
   * or Postgres itself waves it through.
   */
  readonly rls?: boolean;
  /**
   * Refuse a write to a synced table made outside a mesh write (gaps U5): a guard trigger raises
   * on it, and on a `TRUNCATE` of one. Default `true`; `{ except: [table] }` for the tables an
   * external writer owns. A role that can set `syncmesh.armed` itself can get past it.
   */
  readonly strict?: StrictCapture;
  /** Where fetched bytes are cached (D18); absent, an in-memory cache for the process. */
  readonly blobs?: BlobStore;
}

/** Where a node's data lives — one of the two answers, told apart by the connection it names. */
export type Storage = SqliteStorage | PostgresStorage;

/**
 * SQLite on this device, wherever this device keeps it.
 *
 * @example
 * const client = createClient({ schema, procedures, storage: sqlite({ dir: ".rounds" }) });
 */
export const sqlite = (options: Omit<SqliteStorage, "dialect"> = {}): SqliteStorage => ({
  dialect: "sqlite",
  ...options,
});

/**
 * Postgres on a connection you opened.
 *
 * @example
 * import { postgres } from "@syncmesh/orpc";
 * import { postgresDriver } from "@syncmesh/postgres";
 *
 * const server = await createServer({
 *   schema,
 *   procedures,
 *   handlers,
 *   storage: postgres({ driver: postgresDriver(sql), rls: true }),
 * });
 */
export const postgres = (options: Omit<PostgresStorage, "dialect">): PostgresStorage => ({
  dialect: "postgres",
  ...options,
});

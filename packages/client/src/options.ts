import type { EngineError, EventStore, StateStore } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { ColumnsMap, PresenceMap, Schema } from "@syncmesh/schema";
import type {
  BlobStore,
  ScopedStoreSet,
  SqlDialect,
  SqlDriver,
  StoreScope,
  Stores,
} from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { Transport, TransportContext } from "@syncmesh/transport";
import type { Identity } from "@syncmesh/wire";

import type { SessionProvider } from "./auth.js";
import type { Knock, MeshShaping } from "./transports.js";

/**
 * Everything one mesh is constructed from. Grouped rather than flat because the groups are the
 * decisions: where the data lives, who is trusted, what the radios are, and who is calling.
 */
export interface MeshOptions<
  C extends ColumnsMap,
  D extends SqlDialect = "sqlite",
  PC extends PresenceMap = Record<string, never>,
> {
  readonly schema: Schema<C, PC>;
  readonly identity: Identity;
  /**
   * How this device shapes its part of the mesh (book ch. 17): periodic re-peering, and what
   * else belongs to the room rather than to any one medium.
   */
  readonly mesh?: MeshShaping;
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
  /**
   * The set those `stores` came from, and how to delete one scope's files — what lets
   * `mesh.recovery.stores` shed a store this device no longer holds a grant for (book ch. 13).
   *
   * Absent, there is no sweep: a mesh over one driver has nothing to shed but itself. The
   * deletion is yours for the same reason the set is — only the caller knows where the files are.
   */
  readonly sweep?: {
    readonly set: ScopedStoreSet;
    readonly remove: (scope: StoreScope) => Promise<void>;
  };
  /** Where the default store's file goes. Default `.syncmesh`. */
  readonly dataDir?: string;
  readonly undoDepth?: number;
  /** Started at construction (D12); `mesh.transports.add/remove` reshape the set later (book ch. 8). */
  readonly transports?: readonly Transport[];
  /**
   * The platform signals that mean *look at your links again* (see {@link Knock}).
   *
   * Recovery is the library's job, not the app's: an app names the signals its platform has and the
   * mesh does the rest, which is the difference between getting reconnection by existing and
   * rewriting the same `AppState` listener in every app built on this. Absent — and it is absent on
   * every server, where nothing goes to sleep and no radio is switched off in a lift — nothing
   * subscribes and nothing changes.
   *
   * These are *signals*, not a policy. Each one only ever says "something outside changed"; what to
   * do about it belongs to the medium, and each already knows: the relay hangs up an orphaned
   * socket and redials with its backoff reset, the radio stops and restarts discovery.
   */
  readonly knocks?: readonly Knock[];
  /** An ungranted peer asked to exist on some link — forward it to your issuer, or answer with `grants.issue`. Untrusted. */
  readonly onGrantRequest?: TransportContext["onGrantRequest"];
  /**
   * A signed checkpoint this device can offer with the state it serves (RFC-0019, book ch. 4).
   *
   * Read per call rather than held, because the thing it stands for moves: a certificate names a
   * `stateHash` and the coverage that produced it, so the newest one is the only one that matches
   * what this device would send now. Only a process holding the issuer key can mint one — but any
   * process may *forward* one, which is how state travels further than the authority that vouched.
   */
  readonly certificate?: TransportContext["certificate"];
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
  /**
   * Who the user is, and how to prove it (book ch. 14). Every handle then acts as that
   * principal by default, so a call site never names one — a device has one caller, and letting
   * a call site pick is how "acting as" bugs ship. Absent, the device acts as nobody in
   * particular and only the schema's structural checks apply.
   */
  readonly auth?: SessionProvider;
  /**
   * Everything the engine under this mesh reports, from before there is a mesh to report it on.
   *
   * `mesh.engine.onError` subscribes just as well for the life of the process, and for almost
   * everything that is the right door. This one exists for the reports that happen *during*
   * `createMesh`, which a caller cannot have subscribed to, because the call they would subscribe
   * through has not returned yet — and the report that matters most is exactly there.
   * `openEngine` audits the log for {@link StrandedWrites} while it opens, because opening a log
   * under a key that did not write all of it is the moment those writes become undeliverable and
   * the last moment anyone could still be told.
   *
   * A thrower is not contained here: this runs inside boot, and a listener that throws takes
   * `createMesh` down with it. Keep it to reporting.
   */
  readonly onError?: (error: EngineError) => void;
  readonly now?: () => Temporal.Instant;
}

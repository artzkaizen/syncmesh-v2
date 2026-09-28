import type { Engine } from "@syncmesh/engine";
import type { EventId, InvalidPartitionKey, Stamp, Row as WireCells } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { PresenceMap, PresenceTopic, SchemaEntry } from "@syncmesh/schema";
import type { SqlDialect, SqlDriver } from "@syncmesh/storage";
import type { RouteTable } from "@syncmesh/transport";

import type { MeshAccounts } from "./accounts.js";
import type { Auth } from "./auth.js";
import type { Blobs } from "./blobs.js";
import type { DeliveredOptions, ReceivedOptions } from "./delivered.js";
import type { Drafts } from "./drafts.js";
import type { PartitionSealed } from "./errors.js";
import type { MeshGrants } from "./grants.js";
import type { Handle, OnOptions } from "./handles.js";
import type { HistoryViewOptions, RevisionView } from "./history-view.js";
import type { Inspect, Teardown } from "./inspect.js";
import type { MeshInternal } from "./internal.js";
import type { OperationsView } from "./operations.js";
import type { Peers } from "./peers.js";
import type { Topics } from "./presence.js";
import type { ReadCoverageView } from "./read-coverage.js";
import type { RecoveryView } from "./recovery.js";
import type { Status } from "./status.js";
import type { MeshTelemetrySeam } from "./telemetry.js";
import type { RunningTransports } from "./transports.js";

/** One table as anything outside the app's own generics reads it: the entry the manifest built. */
export type MeshSchemaEntry = SchemaEntry;

/**
 * What the manifest says, for anything that has to enumerate rather than write: which tables
 * sync and where their rows live, the declared kinds, which are sealed, and the presence topics.
 *
 * A narrowing rather than a copy: `mesh.schema` **is** the manifest the validator and the fold
 * are reading, and this type is all of it anything outside can see — so there is nothing here to
 * keep in step. What it leaves out it leaves out on purpose. `merge`, `rolesFor` and the typed
 * `tables` map are the fold's and the validator's business, and handing them out would be a
 * second way to reach the write path.
 */
export interface MeshSchema {
  /** Every synced table, where its rows live, and its rules as data. */
  readonly entries: readonly MeshSchemaEntry[];
  /** The declared kinds, in the order the manifest first references them; never a reserved one. */
  readonly kinds: readonly string[];
  /**
   * The kinds whose content is end-to-end encrypted (book ch. 14) — what tells a reader that an
   * empty table is *sealed* rather than empty, which is the difference between a diagnosis and a
   * wrong one.
   */
  readonly sealedKinds: ReadonlySet<string>;
  /** The ephemeral topics, in declaration order; empty for a manifest that declares none. */
  readonly presence: readonly PresenceTopic[];
}

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
  readonly on: (
    instance?: string,
    options?: OnOptions,
  ) => Result<Handle<D>, InvalidPartitionKey | PartitionSealed>;
  /** The row's writes oldest-first by stamp. A detail-view read: it scans the log. */
  readonly history: (
    table: string,
    key: string,
    options?: HistoryViewOptions,
  ) => Promise<Result<readonly RevisionView[], unknown>>;
  /**
   * The delete that is hiding a row, or `undefined` for one that is visible and for one this
   * device has never held — `Engine.deletedAt` at the door an app actually stands at.
   *
   * Here as well as on the engine because of the arguments, not the answer. A table name and a
   * row key are branded strings the kernel mints, and a screen holding `"issue"` and an id has
   * neither; {@link Mesh.history} takes the same pair as plain text, for the same reason and one
   * line above.
   *
   * It is the only read of this fact that survives the fold. A row that stops being visible is
   * deleted outright from the app's own tables, so a procedure, a `SELECT` and `query` alike
   * answer *deleted* and *never heard of* with one empty result. What may honestly be said from
   * the stamp is on `Engine.deletedAt`: it names a **device**, not an account, and carries that
   * device's clock rather than this one's.
   */
  readonly deletedAt: (table: string, key: string) => Stamp | undefined;
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
  /**
   * What this device's manifest declares, for a reader that must enumerate it ({@link MeshSchema}).
   *
   * On the mesh rather than fetched from the app, because three things want it — a diagnostic
   * pane, a migration check, a schema viewer — and each of them inventing its own way to be
   * handed the manifest is three ways for one of them to be handed a stale one.
   */
  readonly schema: MeshSchema;
  /**
   * Read-only SQL over the connection the mesh's own tables live on; absent for a mesh over a
   * bare event store, which has no connection to offer.
   *
   * The driver's `all` with no `run` beside it, and the omission is the whole design. The only
   * other SQL door is `mesh.on().db`, whose proxy classifies every statement and turns an
   * `insert`, `update` or `delete` into a **signed event** — so somebody "just fixing a row"
   * through a handle has written to every peer. A door shaped like this one cannot be used that
   * way by accident.
   *
   * What it does not do is enforce it. `all` will execute whatever SQLite or Postgres accepts,
   * and a caller determined to write can; what it buys is that the write is no longer the
   * obvious thing to reach for, and that a statement run here is invisible to capture and
   * therefore diverges — loudly, in the app's own tables — rather than quietly replicating.
   */
  readonly query?: SqlDriver["all"];
  /** The reserved tables, read through the engine's own folds rather than a second copy. */
  readonly internal: MeshInternal;
  /** The write ledger: durable operation records and their receipts; absent for a mesh over a bare event store. */
  readonly operations?: OperationsView;
  /** What is stuck and why, as stable causes; `run` is the operator's idempotent nudge ({@link RecoveryView}). */
  readonly recovery: RecoveryView;
  /** Leak counters: what was handed out and never released shows here, loudly ({@link Inspect}). */
  readonly inspect: Inspect;
  /**
   * The radios at runtime: a settings toggle adds one, removing one removes a route, never data.
   * `onLinkEvent` is here rather than beside `onTelemetry` because it follows the set — the one
   * feed that keeps speaking about a medium enabled after the subscription was taken.
   *
   * `force`/`release`/`forced` are here and not hidden behind a devtool because the fact belongs
   * to the mesh: a medium held in `radio-off` *is* a medium in `radio-off`, so `$status` says so
   * and health goes `offline` without anything knowing an inspector exists. `forced()` is the one
   * reading that separates **this radio is off** from **somebody turned this radio off**, which
   * is the difference between a bug and a toggle left on.
   */
  readonly transports: Pick<
    RunningTransports,
    "add" | "remove" | "list" | "onLinkEvent" | "force" | "release" | "forced"
  >;
  /** Per-source diagnosis and one overall health, for the screen that explains itself ({@link Status}). */
  readonly status: Status;
  /** Who this device can reach, over what — the substrate routing reads ({@link Peers}). */
  readonly peers: Peers;
  /**
   * Routes that span hops (book ch. 17): `routes.to("authority")` answers with the next hop and
   * how far, or `undefined` in a dead zone — which is the honest answer rather than a hang.
   */
  readonly routes: RouteTable;
  /** The session: who is calling, until when, and how to end it ({@link Auth}). */
  readonly auth: Auth;
  /** Local-only data with no replication promise ({@link Drafts}); absent with no SQL connection. */
  readonly drafts?: Drafts;
  /** Every transport's queue has run out; never rejects, never stops early (`createFlush`). */
  readonly flush: () => Promise<void>;
  /** One listener for `engine.*` and `mesh.*` alike (D17); a thrower never decides a write. */
  readonly onTelemetry: (listener: Parameters<MeshTelemetrySeam["onTelemetry"]>[0]) => Teardown;
  /** Every transport ready (or force-ready); rejects if one failed to start. */
  readonly ready: () => Promise<void>;
  /**
   * Every source that could still fill a scope has finished its first pass — what to await
   * before drawing an empty state (RFC-0019). Sources answer nearest first: this device's own
   * storage has already spoken by the time a mesh exists, then a relay, then a radio.
   */
  readonly settled: () => Promise<void>;
  /**
   * How much of the world has answered, with the source and checkpoint it is good to (book
   * ch. 9) — `settled()`'s per-source completions kept instead of collapsed into one promise.
   */
  readonly coverage: ReadCoverageView;
  readonly running: () => boolean;
  /** Asks every connected peer for a grant for this device (flow A). */
  readonly requestGrant: (invite?: string) => void;
  /** Stops every transport, then closes what the mesh opened; a store or driver you passed stays yours. */
  readonly stop: () => Promise<void>;
}

import type { HandleCounts, MeshHealth } from "@syncmesh/client";
import type {
  EventHeader,
  RecentEvents,
  StoreFailure,
  TelemetryStats,
  Unsubscribe,
} from "@syncmesh/engine";
import type { EventId, PeerId, SeqNum } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { Temporal } from "@syncmesh/temporal";
import type { LinkEventKind, TransportCondition, TransportKind } from "@syncmesh/transport";

import { TaggedError } from "@syncmesh/result";

/**
 * What a panel is allowed to know about a running mesh, and how it is allowed to ask.
 *
 * The seam exists for one measured reason. Three of the four facts a panel wants come off the
 * same two hubs — `engine.onFoldBatch` and `engine.onAcknowledge` — and both run **synchronously
 * inside the write path**, so a design where each panel subscribes for itself pays the fold tax
 * once per installed panel on every write the app makes. Here there is one coalesced feed and N
 * pull-shaped readers: {@link DevtoolsSource.onChange} says which facts moved, and the panel that
 * cares re-reads the snapshot it needs.
 *
 * Four rules are encoded rather than documented. **Snapshots are plain data** — no `Transport`,
 * no `Engine`, nothing with a method on it, so a panel that can serialise its input can run in
 * another window or in a test. **Every async read says so in its type**, because a `Promise` here
 * means SQL or the log. **Errors are values**, so a panel renders a refusal instead of taking the
 * page down with it. And **nothing here mutates**: no `run`, no `rebuild`, no `add`/`remove`. An
 * operator action is a separate surface a host app opts into deliberately.
 *
 * Three things are absent on purpose and must not be added back. `engine.state()` hands over the
 * device's entire folded state by reference; `$recovery.export` hands over somebody's signed
 * envelope; `$grants.wireFor` hands over a bearer credential. A grant rendered as fields is a
 * diagnosis, and a grant rendered as bytes is a password on a screen.
 */

/**
 * Which facts moved since the last notification.
 *
 * A set rather than a stream of events, because the whole point of coalescing is that a hundred
 * folds in one tick are one repaint. A panel reads the channels it was built on and ignores the
 * rest — Timings must never re-render on `fold`, and Storage must never re-read on it either: a
 * catch-up folds in batches and would turn a `COUNT(*)` into a render storm.
 */
export type DevtoolsChannel =
  | "fold"
  | "ack"
  | "link"
  | "route"
  | "grant"
  | "auth"
  | "quarantine"
  | "writes";

/** Who this device is, and who it is currently acting as. Two questions, and they differ. */
export interface DevtoolsIdentity {
  readonly peer: PeerId;
  /**
   * From this device's own *live* grant — absent when none was ever issued **or** when the one it
   * held has lapsed, both of which are the answer to "why will nothing I write appear anywhere".
   * {@link DevtoolsSource.grants} keeps the lapsed one, because that is the grant a reader came
   * to look at.
   */
  readonly account: string | undefined;
  readonly role: string | undefined;
  /** The instances that grant covers, as keys. Empty for a device with no grant. */
  readonly partitions: readonly string[];
  /** The principal handles act as by default; `undefined` before the first session. */
  readonly session: { readonly account: string; readonly role: string | undefined } | undefined;
  readonly sessionExpiresAt: Temporal.Instant | undefined;
}

/**
 * One medium as a settings screen would draw it, and as a diagnostic screen needs it.
 *
 * `condition` and `online` are two different questions and the gap between them is where the
 * interesting failures live: a radio whose `condition()` reads `ok` while its own `onStatus` last
 * said `false` is a medium that believes it is fine and is not carrying. Folding one into the
 * other — which is what `$status` does, because it has only one field to answer with — hides
 * exactly that case.
 *
 * The last three are absent-capability-shaped, like the rest of this port: a medium that has never
 * spoken about its status, or that multiplexes and declares no link limit, says nothing rather
 * than a number somebody would draw a meter against.
 */
export interface DevtoolsMedium {
  readonly name: string;
  readonly kind: TransportKind;
  /** What the medium says about itself, or the most `$status` can infer from `onStatus` alone. */
  readonly condition: TransportCondition;
  /** What this medium's own `onStatus` last said; `undefined` from one that has never spoken. */
  readonly online: boolean | undefined;
  /** Links this medium says it sustains (E28); `undefined` for a relay that multiplexes a room. */
  readonly maxLinks: number | undefined;
  /** Which pass this source answers in (RFC-0019): 0 own storage, 1 relay, 2 radio. Default 1. */
  readonly priority: number;
}

export interface DevtoolsOverview {
  readonly health: MeshHealth;
  readonly mediums: readonly DevtoolsMedium[];
  /**
   * Leak counters, not statistics. A non-zero `observers` after a screen unmounts has found a
   * bug, which makes this the one surface here with a correctness use rather than an interest one.
   *
   * One of the `subscriptions` is the source's own: it holds a mesh-level telemetry listener for
   * the whole devtool, and a count that pretended otherwise would be a leak counter that lies
   * about the thing counting it.
   */
  readonly handles: HandleCounts;
  readonly running: boolean;
  /**
   * Whether `mesh.settled()` has resolved. A promise nothing re-announces, so the source awaits
   * it once and this is the flag it sets — which is why an Overview panel wants a slow poll
   * beside its subscription rather than trusting a channel to fire.
   */
  readonly settled: boolean;
  readonly peers: number;
  readonly grants: number;
  readonly parked: number;
}

/** Per author, where this device has got to. `ahead` and `holding` are the two halves of D13. */
export interface DevtoolsAuthor {
  readonly peer: PeerId;
  /**
   * The highest sequence below which every event is held — the only half anti-entropy can ask a
   * question with. Absent when nothing of this author's run is contiguous here, which is a fact
   * about the gap and not a zero.
   */
  readonly cursor: SeqNum | undefined;
  readonly ahead: number;
  /** Folded past a gap *or* parked below one; never smaller than `ahead`. */
  readonly holding: number;
}

/**
 * What one peer last said it holds, with the moment it said it.
 *
 * `at` is the difference between "that peer is behind" and "that peer has not been heard from
 * since Tuesday", and only one of those two readings is about sync.
 */
export interface DevtoolsAck {
  readonly peer: PeerId;
  readonly at: Temporal.Instant;
  /** How far it had got through *this* device's own run — the number `delivered` is decided on. */
  readonly ours: SeqNum | undefined;
  /** How many authors its cursors named, which is the cheap shape of how much it knows. */
  readonly authors: number;
}

/**
 * One stuck event with the one thing that would move it.
 *
 * The bytes are deliberately not here. `Parked.entry.core` is the author's signed envelope, and a
 * panel that showed it would be putting somebody's rows on a screen as a side effect of counting
 * what is broken.
 */
export interface DevtoolsParked {
  readonly event: EventId;
  readonly author: PeerId;
  readonly kind: "missing-capability" | "refused";
  readonly verdict: string;
  readonly message: string;
  /** What would unblock it, in a sentence; empty when the mesh no longer knows the event. */
  readonly next: string;
  readonly retryWorthwhile: boolean;
}

export interface DevtoolsSync {
  readonly authors: readonly DevtoolsAuthor[];
  /** The interest these cursors are true for (D23); absent is the plainer, stronger claim. */
  readonly scope: string | undefined;
  readonly acks: readonly DevtoolsAck[];
  readonly parked: readonly DevtoolsParked[];
}

export interface DevtoolsPeer {
  readonly peer: PeerId;
  /** Medium names, in attach order. A peer on two radios has two entries here, not two rows. */
  readonly over: readonly string[];
  readonly ackedAt: Temporal.Instant | undefined;
}

export interface DevtoolsRoute {
  readonly to: string;
  readonly via: PeerId;
  /** Hops from **this** device, so a direct neighbour is 1. */
  readonly hops: number;
  readonly expiresAt: Temporal.Instant;
}

/** One link-level ending, as the medium reported it. Plain data; the `Transport` stays behind. */
export interface DevtoolsLinkEvent {
  /**
   * Its place in this source's own count of endings — a React key, a thing to link a row to, and
   * nothing the mesh has ever heard of. Ring position cannot do that job: the same slot holds a
   * different ending five minutes later, and a row keyed by it would silently become another row.
   */
  readonly id: number;
  readonly kind: LinkEventKind;
  readonly transport: string;
  /** Absent below the handshake, which is most drops: a malformed frame names nobody. */
  readonly peer: PeerId | undefined;
  readonly why: string | undefined;
  readonly at: Temporal.Instant;
}

/** One medium's count of one kind of ending, over the endings this source still holds. */
export interface DevtoolsEndingTally {
  readonly transport: string;
  readonly kind: LinkEventKind;
  readonly count: number;
}

export interface DevtoolsLinks {
  readonly self: PeerId;
  readonly peers: readonly DevtoolsPeer[];
  /**
   * Mediums that cannot enumerate their links. Absent from {@link DevtoolsLinks.peers} is "cannot
   * say", never "reaches nobody", and rendering the two the same way is how a relay gets reported
   * as down while it is carrying everything.
   */
  readonly silent: readonly string[];
  readonly routes: readonly DevtoolsRoute[];
  /**
   * How the endings still in the ring break down, per medium and kind, busiest first.
   *
   * Here rather than in each panel because every panel that draws the feed wants it and the walk
   * is the same walk. It counts what is **in the ring** and says no more than that: a medium that
   * refused four hundred dials in an hour reports the two hundred still held, which is a bound a
   * reader can be told about and a lie a reader cannot detect if it is presented as a total.
   */
  readonly tally: readonly DevtoolsEndingTally[];
  /**
   * The ring of recent endings, newest first.
   *
   * Every other fact on this interface is a snapshot a panel can re-read at will; this one is a
   * stream, and a device that was refused six times in a minute has nothing left to show for it
   * unless somebody kept the six. That is what makes *why does this peer keep dropping* an
   * answerable question, and it is the only history this source holds.
   */
  readonly recent: readonly DevtoolsLinkEvent[];
}

/** One synced table as a reader enumerating them sees it. */
export interface DevtoolsTable {
  readonly table: string;
  readonly partition: string;
  readonly visibility: "partition" | "authority";
  /** Its kind's content is end-to-end encrypted: an empty panel here is *sealed*, not empty. */
  readonly sealed: boolean;
}

export interface DevtoolsSchema {
  readonly tables: readonly DevtoolsTable[];
  readonly sealedKinds: readonly string[];
  readonly presence: readonly string[];
}

/**
 * Rows in the log per author and scope, and what they cost.
 *
 * `peer` is the `peer` column verbatim rather than a parsed {@link PeerId}, because this is a
 * reading of a database and not a claim about the mesh: a row nobody can parse is exactly the row
 * a person opened this panel to find, and dropping it to keep the type tidy would hide it.
 */
export interface DevtoolsLogRows {
  readonly peer: string;
  /** A write that never left this device, numbered in its own sequence namespace. */
  readonly local: boolean;
  readonly events: number;
  readonly topSeq: number;
  /** `SUM(length(core))` — what the log weighs, and never a word of what it says. */
  readonly bytes: number;
}

export interface DevtoolsStore {
  /** The migration this database is at; `undefined` where the dialect could not be asked. */
  readonly version: number | undefined;
  readonly log: readonly DevtoolsLogRows[];
  readonly tables: readonly { readonly table: string; readonly rows: number }[];
  /** Compaction floors per author and scope — what has already been removed from below. */
  readonly floors: readonly {
    readonly peer: string;
    readonly local: boolean;
    readonly seq: number;
  }[];
  readonly writes: readonly { readonly status: string; readonly count: number }[];
}

/**
 * One log header as a panel reads it: the engine's own header, plus the name where this device
 * has one to give.
 *
 * `label` is not on `EventHeader` and should not be. A header is an engine fact and the engine
 * keeps no ledger; the name comes from the operation record this device wrote beside the event,
 * and joining the two is a devtool's job rather than the log's. It is therefore **only ever set
 * for this device's own writes** — the ledger holds nothing about an event that arrived from
 * somewhere else, and naming one of those would mean decoding the core its author signed, which
 * is the single thing a header exists to avoid.
 */
export interface DevtoolsEvent extends EventHeader {
  /** The procedure the write ran as, where the ledger has it. Never set for another peer's event. */
  readonly label: string | undefined;
}

export interface DevtoolsWrite {
  readonly id: string;
  readonly label: string;
  readonly peer: PeerId;
  readonly seq: SeqNum;
  readonly at: Temporal.Instant;
  readonly status: string;
  /** Set when an authority overwrote this write's values, and why (RFC-0014). */
  readonly correctedBy: string | undefined;
  readonly correctedReason: string | undefined;
}

export interface DevtoolsWrites {
  /** Oldest first: the write that has been waiting longest is the one worth explaining. */
  readonly unsettled: readonly DevtoolsWrite[];
  /** More were waiting than the limit asked for. A count with no bound is a count you cannot trust. */
  readonly truncated: boolean;
}

/**
 * A run of writes this device holds and can never deliver, as fields.
 *
 * The engine's `StrandedWrites` is a `TaggedError` and this is not, deliberately. By the time a
 * panel draws one, the error has already been raised where raising it could still change
 * something — at boot, on `onError`, before a rotation is repeated. What is left over is a
 * *reading*, and a reading is plain data like every other member of this contract.
 *
 * One row per retired author rather than per event, because the author is the unit of the
 * problem: a key rotation over a log that was kept strands a whole run, and what a person needs
 * is which identity went quiet and how much went with it — not 86 lines.
 */
export interface DevtoolsStranded {
  /** The retired identity: the author no key on this device can sign for any more. */
  readonly author: PeerId;
  readonly count: number;
  /** The run's ends, so the count can be read against what the log otherwise shows. */
  readonly from: SeqNum;
  readonly to: SeqNum;
  readonly message: string;
}

/**
 * One grant as fields.
 *
 * `claims` is names only. The values are free-form facts an issuing server vouched for, which in
 * practice is where an email address or an employee number ends up; a reader diagnosing "why can
 * this device not write" needs to know a claim is *there*, and never needs to read it.
 */
export interface DevtoolsGrant {
  readonly device: PeerId;
  readonly account: string;
  readonly role: string | undefined;
  readonly partitions: readonly string[];
  /** Instances this grant carries a content key for; the wrapped bytes stay in the registry. */
  readonly sealed: readonly string[];
  readonly claims: readonly string[];
  readonly issuedAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
  /** Expiry is a staleness bound rather than a tombstone (D08), so a lapsed grant is still shown. */
  readonly expired: boolean;
}

/** A link a held grant contradicts — surfaced, never resolved, because a row cannot be un-folded. */
export interface DevtoolsDispute {
  readonly device: string;
  readonly partition: string;
  readonly linked: string;
  readonly granted: string;
}

export interface DevtoolsGrants {
  readonly own: DevtoolsGrant | undefined;
  readonly all: readonly DevtoolsGrant[];
  /** Soonest first, counting the ones that already have. */
  readonly expiring: readonly DevtoolsGrant[];
  readonly disputes: readonly DevtoolsDispute[];
}

/** The statement was not one this door will carry. Refused before it reached the database. */
export class QueryRefused extends TaggedError("QueryRefused")<{
  readonly sql: string;
  readonly message: string;
}> {}

/** The database refused it. The driver threw; this is that throw as a value. */
export class QueryFailed extends TaggedError("QueryFailed")<{
  readonly sql: string;
  readonly cause: unknown;
}> {}

/** What a binding will carry. Mirrors the driver's own vocabulary, which is the only one there is. */
export type SqlValue = string | number | bigint | boolean | Uint8Array | Date | null;

/** One result row as positional values, in `SELECT` order. */
export type SqlRow = readonly SqlValue[];

/**
 * The read-only door, or absent where the mesh has no SQL connection to offer.
 *
 * It admits one `SELECT` or `PRAGMA` and nothing else, and that is a speed bump rather than a
 * boundary — `driver.all` will run whatever the database accepts. What the shape buys is that
 * writing is no longer the obvious thing to reach for, which matters because the *other* SQL door
 * on a mesh is `mesh.on().db`, whose proxy turns an `insert` into a **signed event** sent to every
 * peer. The one column this refuses outright is `core`: those are the exact bytes an author
 * signed, and `length(core)` is the reading a devtool is owed.
 */
export interface DevtoolsSql {
  readonly query: (
    sql: string,
    params?: readonly SqlValue[],
  ) => Promise<Result<readonly SqlRow[], QueryRefused | QueryFailed>>;
}

export interface DevtoolsSource {
  readonly identity: () => DevtoolsIdentity;
  readonly overview: () => DevtoolsOverview;
  readonly sync: () => DevtoolsSync;
  readonly links: () => DevtoolsLinks;
  readonly schema: () => DevtoolsSchema;
  /**
   * The log's tail as headers, newest first — the one read that shows a write which never left.
   *
   * Headers, never entries: reading the shape of the traffic must not quietly become reading its
   * contents. Page with `before`, taking the stamp off the last header you were given.
   */
  readonly events: (
    options?: RecentEvents,
  ) => Promise<Result<readonly DevtoolsEvent[], StoreFailure>>;
  /** Async because it is SQL; `undefined` over a bare event store. Never call this from `fold`. */
  readonly storage: (() => Promise<Result<DevtoolsStore, QueryFailed>>) | undefined;
  /** `undefined` when this mesh keeps no write ledger — which a panel renders as a sentence, not an empty table. */
  readonly writes: ((limit: number) => Promise<Result<DevtoolsWrites, StoreFailure>>) | undefined;
  /**
   * Writes this device holds that no key here can ever sign for, so no peer will ever be given
   * them ({@link DevtoolsStranded}).
   *
   * Required, unlike `storage`, `writes` and `sql`. Those three are genuinely absent on a mesh
   * with no SQL door or no ledger, and a panel says so in a sentence. This one is answerable over
   * a bare event store and over a fully wired mesh alike — and the answer that matters is the
   * empty one. A source permitted to go quiet here would look exactly like a healthy device,
   * which is the silence the member exists to end.
   *
   * Nothing re-announces it, so there is no channel for it: a rotation over a kept log happens
   * between processes, never during one, so the set is fixed before the first frame is drawn.
   */
  readonly stranded: () => Promise<Result<readonly DevtoolsStranded[], StoreFailure>>;
  readonly grants: () => DevtoolsGrants;
  /**
   * The shared inspector's aggregates, busiest first. **Poll this; never subscribe.** A device
   * sees seven of the thirteen telemetry variants — the relay half is deliberately not carried to
   * a client — so a panel must say in words that the relay's absence is not the relay being idle.
   */
  readonly timings: () => readonly TelemetryStats[];
  readonly sql: DevtoolsSql | undefined;
  /** The one subscription a panel may hold. Coalesced on a microtask; see {@link DevtoolsChannel}. */
  readonly onChange: (listener: (moved: ReadonlySet<DevtoolsChannel>) => void) => Unsubscribe;
  /** Lets go of every subscription the source took. Safe to call twice. */
  readonly close: () => void;
}

import type { Cursors, EventStore, StoredEvent } from "@syncmesh/engine";
import type { PeerId, SyncEvent } from "@syncmesh/kernel";
import type { BlobStore } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { PresenceStore } from "@syncmesh/transport";
import type { Grant, Identity } from "@syncmesh/wire";

import type { Gate } from "./admission.js";
import type { BlobKeeper } from "./blob-keeper.js";
import type { GrantCache } from "./grant-cache.js";
import type { Budget, RelayLimits } from "./limits.js";
import type { RelaySocket, Sender } from "./sender.js";
import type { RelayTelemetry } from "./telemetry.js";
import type { RoomTrust } from "./trust.js";

export interface Client {
  readonly peer: PeerId;
  readonly sender: Sender;
  readonly socket: RelaySocket;
  /**
   * One live event: sent when this client asked for it and is admitted to it, withheld otherwise
   * — and a withheld one remembered, so the client is told the relay passed over it and the
   * author's later events are not held behind a hole nothing will fill (D23, D24, D40).
   */
  readonly offer: (frame: Uint8Array, event: SyncEvent) => Offered;
  /** The grant this socket was seated under, in a grant-gated room (D40); absent in an open one. */
  readonly granted?: Grant;
  /** Hangs up on this socket with a typed reason — how a revocation reaches it from elsewhere. */
  readonly refuse: (code: string, message: string) => void;
}

/** What one live event cost one socket. */
export interface Offered {
  /** The event itself went out. */
  readonly sent: boolean;
  /** Frames it put on the socket, or queued for it: the event, a pass-over, both, or none. */
  readonly frames: number;
}

/** What one live event cost the room: who received it, and every frame it caused. */
export interface Fanned {
  readonly receivers: number;
  /** The events sent plus the pass-overs they caused — what the sender is charged (gap audit №7). */
  readonly frames: number;
}

/** The room as one connection sees it: shared state, and the three ways to reach the others. */
export interface RoomState {
  readonly store: EventStore;
  readonly epoch: string;
  /** Whether the log outlives this process; every `hello` says so (D42). */
  readonly durable: boolean;
  readonly keepaliveMs: number;
  readonly pageSize: number;
  readonly maxBacklog: number;
  /** The protocol versions this room accepts; `join` offers, the highest in common wins (D14). */
  readonly versions: readonly number[];
  /** The key this room opens each sealed link with (D36): what its hello is signed by. */
  readonly identity: Identity;
  /** What one socket may spend before the relay hangs up on it: frame size and rate. */
  readonly limits: RelayLimits;
  /**
   * What the room as a whole may spend, of which only `fanout` is drawn: every socket's event
   * is charged here as well as to its own budget, at `limits.roomFanout`.
   */
  readonly budget: Budget;
  /** Where this room's bytes live (D18); absent, it serves none and says so. */
  readonly blobs: BlobStore | undefined;
  /** What `blobs` owes (D18): every put goes through it, and every held event is noted to it. */
  readonly keeper: BlobKeeper | undefined;
  /** One grant per device, the room's newest mint for each; a joiner gets these first. */
  readonly grants: GrantCache;
  /** The issuers whose grants admit a device (D40); absent, the room is open. */
  readonly trust: RoomTrust | undefined;
  readonly presence: PresenceStore;
  readonly clients: Map<PeerId, Client>;
  /**
   * Joins held for their ticket (D40), each as the seat's own `offered`: a grant the room admits,
   * from any socket or instance, is offered to every one of them.
   */
  readonly held: Set<() => void>;
  /**
   * Per author, the highest sequence below which the room holds **every** entry it could serve
   * (D13). Contiguous rather than the highest seen, and counted over the entries catch-up can
   * actually send: `hello` carries this, and every client decides what to push from it, so a
   * number above a hole is one nobody will ever fill.
   */
  readonly cursors: () => Cursors;
  /**
   * The other end of the same claim: per author, the highest sequence retention has removed. The
   * pair `(floor, cursors)` is exactly what catch-up can serve, and a joiner whose own cursor for
   * any author sits below this is refused rather than paged a run with the bottom missing.
   */
  readonly floor: () => Cursors;
  /** Every client but one — the author, who already has what it sent. */
  readonly toClients: (frame: Uint8Array, except?: PeerId) => void;
  /** The same, minus every client whose interest or entitlement excludes this event. */
  readonly toInterested: (frame: Uint8Array, event: SyncEvent, except?: PeerId) => Fanned;
  /** The same frame to the other instances serving this room; best-effort by design (D09-B). */
  readonly publish: (frame: Uint8Array) => void;
  readonly offset: () => number;
  /** One more entry in the log: the offset moves, and this author's cursor with it if it can be served. */
  readonly appended: (entry: StoredEvent) => void;
  /** Room-serialized async work, so offsets and acks stay ordered. */
  readonly enqueue: (work: () => Promise<void>) => void;
  /** The room's clock, injectable so a rate limit can be tested without waiting for one. */
  readonly now: () => Temporal.Instant;
  /** The authority-visibility gate (D24); absent, the room withholds nothing it was not asked to. */
  readonly gate: Gate | undefined;
  /** Emitted after the work it describes; a listener can never change what the room did (D17). */
  readonly report: (event: RelayTelemetry) => void;
}

/**
 * One socket's half of the room: its outbound queue, its spending budget, and the one way it is
 * ever told no. Passed as a unit because every part of a conversation — handshake, catch-up,
 * ingest, blobs — needs all three and none of them needs anything else about the socket.
 */
export interface Conversation {
  readonly room: RoomState;
  readonly sender: Sender;
  readonly budget: Budget;
  /**
   * A typed refusal on the wire; `fatal` also hangs up, for a client there is no point talking to.
   * `floor` rides a `retention` refusal: what the client's cursors were below (gaps U30).
   */
  readonly refuse: (code: string, message: string, fatal?: boolean, floor?: Cursors) => void;
}

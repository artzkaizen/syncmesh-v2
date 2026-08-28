import type { Cursors, EventStore, StoredEvent } from "@syncmesh/engine";
import type { PeerId, SyncEvent } from "@syncmesh/kernel";
import type { BlobStore } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { PresenceStore } from "@syncmesh/transport";

import type { GrantCache } from "./grant-cache.js";
import type { Budget, RelayLimits } from "./limits.js";
import type { RelaySocket, Sender } from "./sender.js";
import type { RelayTelemetry } from "./telemetry.js";

export interface Client {
  readonly peer: PeerId;
  readonly sender: Sender;
  readonly socket: RelaySocket;
  /** Whether this client asked for that event; a client with no interest wants them all. */
  readonly wants: (event: SyncEvent) => boolean;
}

/** The room as one connection sees it: shared state, and the three ways to reach the others. */
export interface RoomState {
  readonly store: EventStore;
  readonly epoch: string;
  readonly keepaliveMs: number;
  readonly pageSize: number;
  readonly maxBacklog: number;
  /** The protocol versions this room accepts; `join` offers, the highest in common wins (D14). */
  readonly versions: readonly number[];
  /** What one socket may spend before the relay hangs up on it: frame size and rate. */
  readonly limits: RelayLimits;
  /** Where this room's bytes live (D18); absent, it serves none and says so. */
  readonly blobs: BlobStore | undefined;
  /** One grant per device, the room's newest mint for each; a joiner gets these first. */
  readonly grants: GrantCache;
  readonly presence: PresenceStore;
  readonly clients: Map<PeerId, Client>;
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
  /** The same, minus every client whose interest excludes this event; counts who got it. */
  readonly toInterested: (frame: Uint8Array, event: SyncEvent, except?: PeerId) => number;
  /** The same frame to the other instances serving this room; best-effort by design (D09-B). */
  readonly publish: (frame: Uint8Array) => void;
  readonly offset: () => number;
  /** One more entry in the log: the offset moves, and this author's cursor with it if it can be served. */
  readonly appended: (entry: StoredEvent) => void;
  /** Room-serialized async work, so offsets and acks stay ordered. */
  readonly enqueue: (work: () => Promise<void>) => void;
  /** The room's clock, injectable so a rate limit can be tested without waiting for one. */
  readonly now: () => Temporal.Instant;
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
  /** A typed refusal on the wire; `fatal` also hangs up, for a client there is no point talking to. */
  readonly refuse: (code: string, message: string, fatal?: boolean) => void;
}

import type { PeerId } from "@syncmesh/kernel";
import type { SeqNum } from "@syncmesh/kernel";

import type { StoredEvent } from "./store.js";

/** Per author, the highest sequence number a peer holds. */
export type Cursors = ReadonlyMap<PeerId, SeqNum>;

/** Cursors per scope: what a state has folded, or what a log has compacted below. */
export interface Coverage {
  readonly synced: Cursors;
  readonly local: Cursors;
}

export const EMPTY_COVERAGE: Coverage = { synced: new Map(), local: new Map() };

/** What one side remembers about the other between messages; a received message replaces it whole. */
export interface SyncState {
  readonly theirCursors?: Cursors;
  /** A message is out and unanswered; nothing more is sent until a reply clears it. */
  readonly inFlight: boolean;
  /** Our cursors have gone out at least once, so the other side can ack us even if it has nothing to send. */
  readonly sentCursors: boolean;
}

export type SyncMessage =
  | { readonly kind: "cursors"; readonly cursors: Cursors }
  | { readonly kind: "events"; readonly events: readonly StoredEvent[]; readonly cursors: Cursors };

/** A snapshot of the local log the pure steps read from: no I/O, no clock. */
export interface SyncDoc {
  readonly cursors: Cursors;
  readonly eventsSince: (theirs: Cursors) => readonly StoredEvent[];
}

export const initialSyncState: SyncState = { inFlight: false, sentCursors: false };

/** Decides what to send next, or nothing: our cursors once, then only the events the other side lacks. */
export function generateSyncMessage(
  state: SyncState,
  doc: SyncDoc,
): readonly [SyncState, SyncMessage | undefined] {
  if (state.inFlight) return [state, undefined];
  if (!state.sentCursors) {
    return [
      { ...state, inFlight: true, sentCursors: true },
      { kind: "cursors", cursors: doc.cursors },
    ];
  }
  if (state.theirCursors === undefined) return [state, undefined];
  const events = doc.eventsSince(state.theirCursors);
  if (events.length === 0) return [state, undefined];
  return [
    { theirCursors: advance(state.theirCursors, events), inFlight: true, sentCursors: true },
    { kind: "events", events, cursors: doc.cursors },
  ];
}

/** Absorbs a message: learns the other side's cursors, clears `inFlight`, and returns the events to fold. */
export function receiveSyncMessage(
  state: SyncState,
  message: SyncMessage,
): readonly [SyncState, readonly StoredEvent[]] {
  const next: SyncState = {
    theirCursors: message.cursors,
    inFlight: false,
    sentCursors: state.sentCursors,
  };
  return [next, message.kind === "events" ? message.events : []];
}

/** Whether `have` covers everything in `want`. */
export function coversCursors(have: Cursors, want: Cursors): boolean {
  for (const [peer, seq] of want) if ((have.get(peer) ?? 0) < seq) return false;
  return true;
}

const advance = (cursors: Cursors, entries: readonly StoredEvent[]): Cursors => {
  const next = new Map(cursors);
  for (const { event: e } of entries)
    if ((next.get(e.peerId) ?? 0) < e.seqNum) next.set(e.peerId, e.seqNum);
  return next;
};

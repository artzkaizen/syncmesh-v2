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
  /** The cursors we last told them we hold; folding their events advances ours past this, and that progress must be said. */
  readonly lastSent?: Cursors;
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

/**
 * Decides what to send next, or nothing: our cursors first, the events the other side lacks,
 * and a fresh `cursors` whenever ours advanced past what we last said — without that ack, a
 * peer that only receives would never be known to hold anything (`acknowledge`, `compact`).
 */
export function generateSyncMessage(
  state: SyncState,
  doc: SyncDoc,
): readonly [SyncState, SyncMessage | undefined] {
  if (state.inFlight) return [state, undefined];
  if (!state.sentCursors) {
    return [
      { ...state, inFlight: true, sentCursors: true, lastSent: doc.cursors },
      { kind: "cursors", cursors: doc.cursors },
    ];
  }
  if (state.theirCursors === undefined) return [state, undefined];
  const events = doc.eventsSince(state.theirCursors);
  if (events.length === 0) {
    if (state.lastSent !== undefined && coversCursors(state.lastSent, doc.cursors))
      return [state, undefined];
    return [
      { ...state, inFlight: true, lastSent: doc.cursors },
      { kind: "cursors", cursors: doc.cursors },
    ];
  }
  return [
    {
      theirCursors: advance(state.theirCursors, events),
      inFlight: true,
      sentCursors: true,
      lastSent: doc.cursors,
    },
    { kind: "events", events, cursors: doc.cursors },
  ];
}

/** Absorbs a message: learns the other side's cursors, clears `inFlight`, and returns the events to fold. */
export function receiveSyncMessage(
  state: SyncState,
  message: SyncMessage,
): readonly [SyncState, readonly StoredEvent[]] {
  const next: SyncState = { ...state, theirCursors: message.cursors, inFlight: false };
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

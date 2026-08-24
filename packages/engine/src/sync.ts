import type { PeerId } from "@syncmesh/kernel";

import type { SeqNum, SyncEvent } from "./event.js";

/** Per author, the highest sequence number a peer holds. */
export type Cursors = ReadonlyMap<PeerId, SeqNum>;

/** What one side remembers about the other between messages; a received message replaces it whole. */
export interface SyncState {
  readonly theirCursors?: Cursors;
  /** A message is out and unanswered; nothing more is sent until a reply clears it. */
  readonly inFlight: boolean;
}

export type SyncMessage =
  | { readonly kind: "cursors"; readonly cursors: Cursors }
  | { readonly kind: "events"; readonly events: readonly SyncEvent[]; readonly cursors: Cursors };

/** A snapshot of the local log the pure steps read from: no I/O, no clock. */
export interface SyncDoc {
  readonly cursors: Cursors;
  readonly eventsSince: (theirs: Cursors) => readonly SyncEvent[];
}

export const initialSyncState: SyncState = { inFlight: false };

/** Decides what to send next, or nothing: cursors first, then only the events the other side lacks. */
export function generateSyncMessage(
  state: SyncState,
  doc: SyncDoc,
): readonly [SyncState, SyncMessage | undefined] {
  if (state.inFlight) return [state, undefined];
  if (state.theirCursors === undefined) {
    return [
      { ...state, inFlight: true },
      { kind: "cursors", cursors: doc.cursors },
    ];
  }
  const events = doc.eventsSince(state.theirCursors);
  if (events.length === 0) return [state, undefined];
  return [
    { theirCursors: advance(state.theirCursors, events), inFlight: true },
    { kind: "events", events, cursors: doc.cursors },
  ];
}

/** Absorbs a message: learns the other side's cursors, clears `inFlight`, and returns the events to fold. */
export function receiveSyncMessage(
  message: SyncMessage,
): readonly [SyncState, readonly SyncEvent[]] {
  const next: SyncState = { theirCursors: message.cursors, inFlight: false };
  return [next, message.kind === "events" ? message.events : []];
}

/** Whether `have` covers everything in `want`. */
export function coversCursors(have: Cursors, want: Cursors): boolean {
  for (const [peer, seq] of want) if ((have.get(peer) ?? 0) < seq) return false;
  return true;
}

const advance = (cursors: Cursors, events: readonly SyncEvent[]): Cursors => {
  const next = new Map(cursors);
  for (const e of events) if ((next.get(e.peerId) ?? 0) < e.seqNum) next.set(e.peerId, e.seqNum);
  return next;
};

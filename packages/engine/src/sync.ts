import type { PeerId } from "@syncmesh/kernel";
import type { SeqNum } from "@syncmesh/kernel";

import type { StoredEvent } from "./store.js";

/**
 * Per author, the highest sequence number below which a peer holds **every** event — the
 * contiguous half of D13's `{ contiguous, ahead }`. What travels, because it is the only half
 * anti-entropy can ask a question with: "send me everything after this" is a lie the moment the
 * number sits above a hole.
 */
export type Cursors = ReadonlyMap<PeerId, SeqNum>;

/**
 * Per author, the sequence numbers a peer holds *above* its cursor — the far side of a gap.
 * Advisory, and only ever narrows what a sender bothers to send: a peer that omits it is sent
 * the run again and skips the duplicates, which is the old behaviour exactly.
 */
export type Ahead = ReadonlyMap<PeerId, readonly SeqNum[]>;

/**
 * Both halves of what a device holds above its cursors — folded past a gap, and parked below
 * one. A peer needs no way to tell them apart: either way this device has the bytes and does not
 * want them again.
 */
export const mergeAhead = (a: Ahead, b: Ahead): Ahead => {
  const merged = new Map<PeerId, SeqNum[]>();
  for (const source of [a, b])
    for (const [peer, seqs] of source) merged.set(peer, [...(merged.get(peer) ?? []), ...seqs]);
  for (const [peer, seqs] of merged)
    merged.set(
      peer,
      [...new Set(seqs)].sort((x, y) => x - y),
    );
  return merged;
};

/**
 * Whether two peers hold the same events *above* their cursors. Equal cursors alone no longer
 * mean equal folded sets: that is the whole point of `{ contiguous, ahead }` — a peer can hold
 * events its cursor does not describe. Anything comparing two peers' rows has to check both
 * halves or it will read "one of us is one event ahead" as divergence (E16).
 */
export const sameAhead = (a: Ahead, b: Ahead): boolean => {
  for (const peer of new Set([...a.keys(), ...b.keys()])) {
    const [ours, theirs] = [a.get(peer) ?? [], b.get(peer) ?? []];
    if (ours.length !== theirs.length) return false;
    if (ours.some((seq, i) => Number(seq) !== Number(theirs[i] ?? 0))) return false;
  }
  return true;
};

/** Cursors per scope: what a state has folded, or what a log has compacted below. */
export interface Coverage {
  readonly synced: Cursors;
  readonly local: Cursors;
}

export const EMPTY_COVERAGE: Coverage = { synced: new Map(), local: new Map() };

/** What one side remembers about the other between messages; a received message replaces it whole. */
export interface SyncState {
  readonly theirCursors?: Cursors;
  /** What they said they hold past their own gaps; those events are not worth sending again. */
  readonly theirAhead?: Ahead;
  /** A message is out and unanswered; nothing more is sent until a reply clears it. */
  readonly inFlight: boolean;
  /** Our cursors have gone out at least once, so the other side can ack us even if it has nothing to send. */
  readonly sentCursors: boolean;
  /** The cursors we last told them we hold; folding their events advances ours past this, and that progress must be said. */
  readonly lastSent?: Cursors;
}

export type SyncMessage =
  | { readonly kind: "cursors"; readonly cursors: Cursors; readonly ahead?: Ahead }
  | {
      readonly kind: "events";
      readonly events: readonly StoredEvent[];
      readonly cursors: Cursors;
      readonly ahead?: Ahead;
    };

/** A snapshot of the local log the pure steps read from: no I/O, no clock. */
export interface SyncDoc {
  readonly cursors: Cursors;
  /** What this side holds above its own cursor, so the other side stops re-sending it. */
  readonly ahead?: Ahead;
  readonly eventsSince: (theirs: Cursors) => readonly StoredEvent[];
}

export const initialSyncState: SyncState = { inFlight: false, sentCursors: false };

/** Whether they told us they already hold this event past a gap of their own. */
export const heldAhead = (ahead: Ahead | undefined, entry: StoredEvent): boolean =>
  ahead?.get(entry.event.peerId)?.some((seq) => seq === entry.event.seqNum) === true;

/** Adds `ahead` only when there is one: an absent field is "I did not say", not "I hold nothing". */
const saying = (message: SyncMessage, ahead: Ahead | undefined): SyncMessage =>
  ahead === undefined ? message : { ...message, ahead };

/**
 * Decides what to send next, or nothing: our cursors first, the events the other side lacks,
 * and a fresh `cursors` whenever ours advanced past what we last said — without that ack, a
 * peer that only receives would never be known to hold anything (`acknowledge`, `compact`).
 *
 * An event they said they already hold above their cursor is dropped from the run. Without that,
 * a peer parking one event it cannot read (D13) would be sent the whole tail above the hole on
 * every exchange, for as long as the hole lasts — and answer with the same cursor every time.
 */
export function generateSyncMessage(
  state: SyncState,
  doc: SyncDoc,
): readonly [SyncState, SyncMessage | undefined] {
  if (state.inFlight) return [state, undefined];
  if (!state.sentCursors) {
    return [
      { ...state, inFlight: true, sentCursors: true, lastSent: doc.cursors },
      saying({ kind: "cursors", cursors: doc.cursors }, doc.ahead),
    ];
  }
  if (state.theirCursors === undefined) return [state, undefined];
  const events = doc
    .eventsSince(state.theirCursors)
    .filter((entry) => !heldAhead(state.theirAhead, entry));
  if (events.length === 0) {
    if (state.lastSent !== undefined && coversCursors(state.lastSent, doc.cursors))
      return [state, undefined];
    return [
      { ...state, inFlight: true, lastSent: doc.cursors },
      saying({ kind: "cursors", cursors: doc.cursors }, doc.ahead),
    ];
  }
  return [
    {
      ...state,
      theirCursors: advance(state.theirCursors, events),
      inFlight: true,
      sentCursors: true,
      lastSent: doc.cursors,
    },
    saying({ kind: "events", events, cursors: doc.cursors }, doc.ahead),
  ];
}

/** Absorbs a message: learns the other side's cursors, clears `inFlight`, and returns the events to fold. */
export function receiveSyncMessage(
  state: SyncState,
  message: SyncMessage,
): readonly [SyncState, readonly StoredEvent[]] {
  const learned = { ...state, theirCursors: message.cursors, inFlight: false };
  const next: SyncState =
    message.ahead === undefined ? learned : { ...learned, theirAhead: message.ahead };
  return [next, message.kind === "events" ? message.events : []];
}

/** Whether `have` covers everything in `want`. */
export function coversCursors(have: Cursors, want: Cursors): boolean {
  for (const [peer, seq] of want) if ((have.get(peer) ?? 0) < seq) return false;
  return true;
}

/**
 * What they will hold once the run lands, optimistically: the highest sequence sent. Optimistic
 * because a receiver that parks one of them says so in its next message, which replaces this
 * whole guess — and until it does, re-sending a run they are already folding buys nothing.
 */
const advance = (cursors: Cursors, entries: readonly StoredEvent[]): Cursors => {
  const next = new Map(cursors);
  for (const { event: e } of entries)
    if ((next.get(e.peerId) ?? 0) < e.seqNum) next.set(e.peerId, e.seqNum);
  return next;
};

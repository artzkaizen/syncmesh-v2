import type { Ahead, Engine, StoredEvent } from "@syncmesh/engine";
import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";
import type { EventCrypto, Identity } from "@syncmesh/wire";

import { signEvent } from "@syncmesh/wire";

import type { FrameClass } from "./frame-parts.js";
import type { ReadGate } from "./read-gate.js";

import { KIND } from "./frame-parts.js";
import { eventFrame, withheldFrame } from "./frame.js";

/**
 * The two halves of withholding on a peer link (D40): the sender keeps back what the far peer's
 * grant does not cover and names it, and the receiver stops waiting for what was named.
 *
 * Named by sequence rather than claimed as a reach, because a radio loses frames. A reach — "you
 * hold my run up to 9" — would carry a receiver past an event lost in transit as surely as past
 * one withheld on purpose, and nothing would ever offer the lost one again. A sequence named as
 * withheld is skipped; a sequence not named still stops the cursor, and the next exchange asks.
 */

/** Where a link's frames go: the outbox, under the class each frame already is. */
type Emit = (cls: FrameClass, what: string, frame: Uint8Array) => void;

/** One diff for one peer: what to send, and what its grant kept back, per author. */
export interface SplitDiff {
  readonly send: readonly StoredEvent[];
  readonly withheld: Ahead;
}

export function splitDiff(
  entries: readonly StoredEvent[],
  gate: ReadGate,
  peer: PeerId | undefined,
): SplitDiff {
  const send: StoredEvent[] = [];
  const withheld = new Map<PeerId, SeqNum[]>();
  for (const entry of entries) {
    if (!gate.withholds(peer, entry.event)) {
      send.push(entry);
      continue;
    }
    const seqs = withheld.get(entry.event.peerId) ?? [];
    seqs.push(entry.event.seqNum);
    withheld.set(entry.event.peerId, seqs);
  }
  return { send, withheld };
}

/** The frame naming what was kept back, or `undefined` when nothing was. */
export const withheldFor = (
  gate: ReadGate,
  peer: PeerId | undefined,
  withheld: Ahead,
): Uint8Array | undefined =>
  withheld.size === 0 ? undefined : withheldFrame(gate.scope(peer), withheld);

/** What a link's live send needs: who signs, whether routing put the frame here, the gate. */
export interface OfferDeps {
  readonly identity: Identity;
  readonly carries?: (message: { readonly cls: FrameClass; readonly bytes: number }) => boolean;
  readonly crypto?: EventCrypto;
  readonly readGate?: ReadGate;
}

/**
 * Signs the event and offers it to this link, unless routing put it on another one (E28).
 *
 * The size weighed is the **frame's**, not the event's: what occupies a medium is what goes on it.
 * An absent `carries` emits — a link with no routing behind it carries everything, which is what
 * every link did before link admission and what one whose peer is unknown must keep doing.
 */
export const offerEvent = (
  event: SyncEvent,
  options: OfferDeps,
  peer: PeerId | undefined,
  emit: Emit,
): void => {
  const { identity, carries, crypto, readGate } = options;
  // what the far peer may not read is named instead of sent (D40), on every link alike: routing
  // decides which link carries a frame, never whether a peer may read it
  if (readGate?.withholds(peer, event) === true) {
    const named = withheldFor(readGate, peer, new Map([[event.peerId, [event.seqNum]]]));
    if (named !== undefined) emit(KIND.withheld, "withheld", named);
    return;
  }
  const frame = eventFrame(signEvent(event, identity, crypto).wire);
  if (carries?.({ cls: KIND.event, bytes: frame.length }) !== false)
    emit(KIND.event, "event", frame);
};

/**
 * A diff answered to one peer: the events it may read, then the frame naming the ones it may not
 * — after the events, so the peer folds what it was sent before it skips what it was not.
 */
export function sendOwed(
  owed: readonly StoredEvent[],
  deps: {
    readonly gate: ReadGate | undefined;
    readonly peer: PeerId | undefined;
    readonly envelopeOf: (entry: StoredEvent) => Uint8Array | undefined;
    readonly send: Emit;
  },
): void {
  const { gate, peer, envelopeOf, send } = deps;
  const split =
    gate === undefined ? { send: owed, withheld: new Map() } : splitDiff(owed, gate, peer);
  for (const entry of split.send) {
    const wire = envelopeOf(entry);
    if (wire !== undefined) send(KIND.event, "event", eventFrame(wire));
  }
  const named = gate === undefined ? undefined : withheldFor(gate, peer, split.withheld);
  if (named !== undefined) send(KIND.withheld, "withheld", named);
}

/** What the receiving half needs: the engine it folds into, and the holdback it drains. */
export interface WithheldIntake {
  readonly engine: Engine;
  /** Absent in an ungranted mesh, which takes no withheld frame at all. */
  readonly gate: ReadGate | undefined;
  /** The peer the link's handshake proved; `undefined` on a link that runs none. */
  readonly from: PeerId | undefined;
  readonly drain: (author: PeerId) => readonly StoredEvent[];
}

/**
 * Takes a withheld frame: per author, folds what the holdback can release, then steps the cursor
 * over each named sequence it now stands directly below, and folds again — until it stands below
 * one nobody named. Taken only under this device's own entitlement: a frame judged by some other
 * grant is a claim about a slice this device does not hold, and adopting it is how a cursor comes
 * to describe events nobody will send. And only about a run its sender may speak for
 * ({@link ReadGate.attests}): the author's own, or any run from the issuer.
 *
 * Nothing is vouched for here. A receipt claims a whole run (D28), and a cursor that stepped over
 * a withheld sequence stands past an event this device never held.
 */
export async function takeWithheld(
  intake: WithheldIntake,
  scope: string,
  withheld: Ahead,
): Promise<void> {
  const { engine, gate, from, drain } = intake;
  if (gate === undefined || scope !== gate.own()) return;
  for (const [author, seqs] of withheld) {
    if (!gate.attests(from, author)) continue;
    for (;;) {
      const ready = drain(author);
      if (ready.length > 0) {
        const folded = await engine.receiveBatch(ready);
        if (folded.isErr()) return;
      }
      const at = Number(engine.coverage().synced.get(author) ?? 0);
      const next = seqs.find((seq) => Number(seq) === at + 1);
      if (next === undefined) break;
      engine.adoptCoverage({ synced: new Map([[author, next]]), local: new Map(), scope });
    }
  }
}

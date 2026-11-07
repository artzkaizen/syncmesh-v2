import type { Interest } from "@syncmesh/engine";
import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";

import { matchesInterest, scopeText } from "@syncmesh/engine";

import type { Entitlement } from "./admission.js";
import type { CatchUpViewer } from "./catchup.js";
import type { Sender } from "./sender.js";
import type { Offered, RoomState } from "./state.js";

import { admitted } from "./admission.js";
import { pageFrame } from "./frames.js";

/** What one join asked for, and how the socket says no when the authority cannot answer. */
export interface Viewing {
  readonly peer: PeerId;
  readonly interest: Interest | undefined;
  /** Whether the socket has already hung up, so an answer arriving after it is dropped. */
  readonly closed: () => boolean;
  readonly refuse: (code: string, message: string, fatal?: boolean) => void;
}

/**
 * One socket's view of the room (D23, D24): which events it is sent, which it is withheld, and
 * how it is told that the relay passed over what it was withheld — so the author's later events
 * are not held behind a hole nothing will fill. One per join; a re-join starts a fresh one.
 */
export function createViewer(room: RoomState, sender: Sender, viewing: Viewing) {
  const { peer, interest } = viewing;
  /**
   * What the authority said this socket may read of the gated tables; `undefined` until it has
   * said, and every gated event is withheld until then — the catch-up that follows the answer
   * pages what was withheld while it was being asked.
   */
  let entitlement: Entitlement | undefined;
  /** This socket's catch-up has been sent, so a pass-over can no longer outrun its pages. */
  let paged = false;
  /** Per author, the highest sequence withheld from this socket since it was last told so. */
  const withheld = new Map<PeerId, SeqNum>();
  /** A pass-over is waiting on the room's queue, so a run of withheld events costs one frame. */
  let queued = false;

  /**
   * An empty last page with a coverage scoped to this socket's interest and entitlement: *"for
   * your slice, you hold everything of these authors' below N"*. The same frame a filtered
   * catch-up ends with, so a device reads it with the code that already adopts one (D23).
   *
   * Claimed only up to the room's contiguous run, and only where that run has reached what was
   * withheld. Everything below it was paged to this socket, sent live, or withheld — and a claim
   * above it would cover an event the room has not heard yet, which the device would then drop as
   * already held when it arrived. An author whose run still stops below a hole stays owed, and the
   * event that fills the hole is offered here like any other, which asks again.
   */
  const passOver = (): number => {
    const named = scope();
    // nothing is withheld from a socket that filters nothing, so this is always a scope
    if (named === undefined) return 0;
    const cursors = room.cursors();
    const synced = new Map<PeerId, SeqNum>();
    for (const [author, owed] of withheld) {
      const run = cursors.get(author);
      if (run === undefined || run < owed) continue;
      withheld.delete(author);
      synced.set(author, run);
    }
    if (synced.size === 0) return 0;
    sender.send(
      pageFrame([], [], false, room.offset(), { synced, local: new Map(), scope: named }),
    );
    return 1;
  };

  /** Live fan-out obeys the same interest and the same gate the catch-up did. */
  const wants = (event: SyncEvent): boolean =>
    (interest === undefined || matchesInterest(interest, event)) &&
    admitted(room.gate, entitlement, event);

  const scope = (): string | undefined =>
    interest === undefined && entitlement === undefined
      ? undefined
      : scopeText(interest, entitlement?.scope);

  const catchUp: CatchUpViewer = {
    entitle: () => {
      const gate = room.gate;
      if (gate === undefined) return true;
      return gate.entitle(peer).then((answer) => {
        if (viewing.closed()) return false;
        if (answer.isErr()) {
          viewing.refuse("admission", answer.error.message, true);
          return false;
        }
        entitlement = answer.value;
        return true;
      });
    },
    wants,
    // only a filtered run needs the coverage: an unfiltered one leaves the joiner's own fold able
    // to compute the same number
    scope,
    paged: () => void (paged = true),
  };

  return {
    catchUp,
    /**
     * One live event: sent when wanted, otherwise withheld and remembered. Returns what it put on
     * this socket, so the sender can be charged for the frames its write caused (gap audit №7).
     *
     * A withheld event is not answered at once. The pass-over waits on the room's queue, so a burst
     * of events this socket does not want costs it one frame rather than one each — and a wanted
     * event of an owed author sends it straight away, behind itself, so that event never waits in
     * the device's holdback for the queue to drain.
     */
    offer: (frame: Uint8Array, event: SyncEvent): Offered => {
      if (wants(event)) {
        sender.send(frame);
        return { sent: true, frames: 1 + (withheld.has(event.peerId) ? passOver() : 0) };
      }
      // before the catch-up the scan covers it, and its coverage says so; a pass-over sent then
      // could land ahead of the pages and claim events they have not delivered yet
      if (!paged) return { sent: false, frames: 0 };
      const before = withheld.get(event.peerId);
      if (before === undefined || event.seqNum > before) withheld.set(event.peerId, event.seqNum);
      if (queued) return { sent: false, frames: 0 };
      queued = true;
      room.enqueue(async () => {
        queued = false;
        if (!viewing.closed()) passOver();
      });
      // charged now, for the frame the queue will send: by then the write that caused it is gone
      return { sent: false, frames: 1 };
    },
  };
}

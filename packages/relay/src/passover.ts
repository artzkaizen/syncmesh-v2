import type { Interest } from "@syncmesh/engine";
import type { PartitionKey, PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";

import { entitledInterest, matchesInterest, scopeText } from "@syncmesh/engine";

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
  /**
   * In a grant-gated room (D40), the seat's own answer — the grant it sat down under, which may
   * have lapsed since — and the partitions that grant names, which the scope is cut to. Absent in
   * an open room.
   */
  readonly seat?: {
    readonly wants: (event: SyncEvent) => boolean;
    readonly partitions: readonly PartitionKey[];
  };
}

/**
 * One socket's view of the room (D23, D24, D40): which events it is sent, which it is withheld, and
 * how it is told that the relay passed over what it was withheld — so the author's later events
 * are not held behind a hole nothing will fill. One per join; a re-join starts a fresh one.
 */
export function createViewer(room: RoomState, sender: Sender, viewing: Viewing) {
  const { peer, interest, seat } = viewing;
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

  /**
   * Live fan-out obeys the same interest, grant and gate the catch-up did. An `admits` that
   * throws refuses the socket, so nothing after it — no page, no pass-over — claims the event as
   * held, and the join that follows asks again from the device's cursor. A socket already refused
   * wants nothing, so a broken `admits` costs one warning per join and not one per event.
   */
  const wants = (event: SyncEvent): boolean =>
    !viewing.closed() &&
    (seat === undefined || seat.wants(event)) &&
    (interest === undefined || matchesInterest(interest, event)) &&
    admitted(room.gate, entitlement, event).match({
      ok: (yes) => yes,
      err: (error) => {
        // oxlint-disable-next-line no-console -- an app bug the room survives; the device's own error frame does not reach the operator
        console.warn(
          `admits threw on ${event.id}; refusing ${peer} until it joins again:`,
          error.cause,
        );
        viewing.refuse("admission", error.message, true);
        return false;
      },
    });

  /**
   * A sent event that filled a hole under events already in the room: the author's run now
   * reaches past it, and what this socket was passed over above it — in its catch-up, or live
   * before the hole filled — is owed a pass-over too, since the one it got stopped at the hole and
   * nothing else would say it again (D40).
   */
  const fills = (event: SyncEvent): void => {
    const run = room.cursors().get(event.peerId);
    if (run === undefined || run <= event.seqNum) return;
    const before = withheld.get(event.peerId);
    if (before === undefined || run > before) withheld.set(event.peerId, run);
  };

  /** What a grant-gated room serves this socket: the interest cut to its grant (D40). */
  const served = seat === undefined ? interest : entitledInterest(interest, seat.partitions);
  const scope = (): string | undefined =>
    served === undefined && entitlement === undefined
      ? undefined
      : scopeText(served, entitlement?.scope);

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
    closed: viewing.closed,
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
        if (paged) fills(event);
        return { sent: true, frames: 1 + (withheld.has(event.peerId) ? passOver() : 0) };
      }
      // before the catch-up the scan covers it, and its coverage says so; a pass-over sent then
      // could land ahead of the pages and claim events they have not delivered yet. A refused
      // socket is owed nothing: its next join is paged from its own cursor
      if (!paged || viewing.closed()) return { sent: false, frames: 0 };
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

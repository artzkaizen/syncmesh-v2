import type { Interest } from "@syncmesh/engine";
import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";

import { matchesInterest, scopeText } from "@syncmesh/engine";

import type { Entitlement } from "./admission.js";
import type { CatchUpViewer } from "./catchup.js";
import type { Sender } from "./sender.js";
import type { RoomState } from "./state.js";

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
    /** One live event: sent when wanted, otherwise withheld and remembered. `true` when sent. */
    offer: (frame: Uint8Array, event: SyncEvent): boolean => {
      if (wants(event)) {
        sender.send(frame);
        return true;
      }
      // before the catch-up the scan covers it, and its coverage says so; a pass-over sent then
      // could land ahead of the pages and claim events they have not delivered yet
      if (!paged) return false;
      const before = withheld.get(event.peerId);
      if (before === undefined || event.seqNum > before) withheld.set(event.peerId, event.seqNum);
      return false;
    },
    /**
     * An empty last page with a coverage scoped to this socket's interest and entitlement: *"for
     * your slice, you hold everything of this author's below N"*. The same frame a filtered
     * catch-up ends with, so a device reads it with the code that already adopts one (D23).
     *
     * Claimed only up to the room's contiguous run. Everything below it was paged to this socket,
     * sent live, or withheld — and a claim above it would cover an event the room has not heard
     * yet, which the device would then drop as already held when it arrived.
     */
    settle: (author: PeerId, reach: () => SeqNum | undefined): void => {
      const owed = withheld.get(author);
      if (owed === undefined) return;
      const run = reach();
      if (run === undefined || run < owed) return;
      withheld.delete(author);
      // nothing is withheld from a socket that filters nothing, so this is always a scope
      const named = scope();
      if (named === undefined) return;
      const synced = new Map([[author, run]]);
      sender.send(
        pageFrame([], [], false, room.offset(), { synced, local: new Map(), scope: named }),
      );
    },
  };
}

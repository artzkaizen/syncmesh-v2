import type { Interest } from "@syncmesh/engine";
import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { entitledInterest, entitles, interestText, matchesInterest } from "@syncmesh/engine";
import { durationMs } from "@syncmesh/temporal";

import type { RoomState } from "./state.js";

import { pageFrame } from "./frames.js";
import {
  REVOKED,
  REVOKED_MESSAGE,
  UNGRANTED,
  UNGRANTED_MESSAGE,
  entitlement,
  grantWait,
  lapsed,
  sameSet,
} from "./trust.js";

/**
 * What one socket may be served once it has sat down: the interest it asked with, cut to the
 * grant it was seated under in a gated room (D40). One object so catch-up, live fan-out and the
 * live skip notice read the same answer, and so the connection that owns it stays about the
 * protocol rather than the gate.
 */
export interface Seat {
  /** Seats the socket with what it asked for and the grant it holds; `undefined` in an open room. */
  readonly take: (interest: Interest | undefined, grant: Grant | undefined) => void;
  /** The grant this socket sat down under, if the room is gated. */
  readonly granted: () => Grant | undefined;
  /**
   * Whether live fan-out sends this event. A grant that has lapsed since the seat hangs up instead
   * (D40): no event leaves for a socket whose ticket ran out, whether or not a renewal is coming.
   * A renewal that already reached the room, naming the same partitions, is the ticket from then on.
   */
  readonly wants: (event: SyncEvent) => boolean;
  /**
   * An event live fan-out passed over, told as the coverage a catch-up would have ended with: an
   * empty last page whose scoped coverage says the author's run is held up to that event (D23).
   * Without it the filter's hole sits under every later event of that author in the client's
   * holdback until it overflows into a re-join — a stall for every device a gate narrows.
   *
   * The claim is the room's own contiguous cursor for the author, capped at the event: true of
   * everything this socket may read, because all of it was sent, in order, by this connection.
   * Nothing before the seat's own last page: a notice is a last page too, and one ahead of the
   * catch-up would tell the client it had caught up when it had not.
   */
  readonly skipped: (event: SyncEvent) => void;
  /**
   * An event live fan-out sent. When it filled a hole under events already in the room, the
   * author's run now reaches past it, and the ones above it this socket was passed over — before
   * or after its seat — are told as {@link Seat.skipped} tells them: the notice they got capped at
   * the hole, and nothing else would say it again.
   */
  readonly sent: (event: SyncEvent) => void;
  /** This seat's catch-up is on the socket; notices may follow it now. */
  readonly paged: () => void;
  /**
   * Seats now under the grant the room already holds for `peer`, or holds the join until one
   * arrives — the device sends its grants straight after its join — and refuses it `ungranted`
   * once the room's `wait` is up. An open room seats at once. A held join is in the room's `held`
   * set, so a grant the room admits from any socket or instance seats it.
   */
  readonly admit: (peer: PeerId, seat: (grant: Grant | undefined) => void) => void;
  /** Whether a join is waiting on its ticket: the socket's other frames are not acted on meanwhile. */
  readonly waiting: () => boolean;
  readonly close: () => void;
}

/**
 * The live grant the room holds for a lapsed one's device, when it names the same partitions. A
 * renewal naming others has already hung the socket up, as `revoked` or `regranted`, on arrival.
 */
function renewed(room: RoomState, lapsedGrant: Grant): Grant | undefined {
  const renewal = entitlement(room, lapsedGrant.device);
  return renewal !== undefined && sameSet(renewal.partitions, lapsedGrant.partitions)
    ? renewal
    : undefined;
}

/** One socket's seat; `refuse` is the connection's fatal refusal, `send` its outbound queue. */
export function createSeat(
  room: RoomState,
  refuse: (code: string, message: string) => void,
  send: (frame: Uint8Array) => void,
): Seat {
  let interest: Interest | undefined;
  let granted: Grant | undefined;
  let paged = false;
  let held:
    | {
        readonly peer: PeerId;
        readonly seat: (grant: Grant) => void;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  /** A grant reached the room: it may be the ticket the held join is waiting on. */
  const offered = (): void => {
    if (held === undefined) return;
    const grant = entitlement(room, held.peer);
    if (grant !== undefined) held.seat(grant);
  };
  const release = (): void => {
    if (held !== undefined) clearTimeout(held.timer);
    held = undefined;
    room.held.delete(offered);
  };
  /** Set once the seat has hung up on a lapsed ticket: later fan-out passes it over, quietly. */
  let lapsedOut = false;

  /** One empty last page saying `author`'s run is held up to `at`, within this seat's scope. */
  const tell = (author: PeerId, at: SeqNum): void => {
    if (!paged) return;
    const scope =
      granted === undefined ? interest : entitledInterest(interest, granted.partitions);
    if (scope === undefined) return;
    send(
      pageFrame([], [], false, room.offset(), {
        synced: new Map([[author, at]]),
        local: new Map(),
        scope: interestText(scope),
      }),
    );
  };

  return {
    take: (asked, grant) => {
      release();
      interest = asked;
      granted = grant;
      paged = false;
      lapsedOut = false;
    },
    granted: () => granted,
    wants: (event) => {
      if (lapsedOut) return false;
      if (granted !== undefined) {
        if (lapsed(room, granted)) granted = renewed(room, granted);
        if (granted === undefined) {
          lapsedOut = true;
          refuse(REVOKED, REVOKED_MESSAGE);
          return false;
        }
        if (!entitles(granted.partitions, event)) return false;
      }
      return interest === undefined || matchesInterest(interest, event);
    },
    skipped: (event) => {
      const reach = room.cursors().get(event.peerId);
      if (reach === undefined) return;
      tell(event.peerId, Number(reach) < Number(event.seqNum) ? reach : event.seqNum);
    },
    sent: (event) => {
      const reach = room.cursors().get(event.peerId);
      if (reach !== undefined && Number(reach) > Number(event.seqNum)) tell(event.peerId, reach);
    },
    paged: () => void (paged = true),
    admit: (peer, seat) => {
      if (room.trust === undefined) {
        seat(undefined);
        return;
      }
      const cached = entitlement(room, peer);
      if (cached !== undefined) {
        seat(cached);
        return;
      }
      release();
      const timer = setTimeout(
        () => {
          if (held !== undefined) refuse(UNGRANTED, UNGRANTED_MESSAGE);
        },
        durationMs(grantWait(room.trust)),
      );
      held = { peer, seat, timer };
      room.held.add(offered);
    },
    waiting: () => held !== undefined,
    close: release,
  };
}

import type { Interest } from "@syncmesh/engine";
import type { PartitionKey, PeerId, SyncEvent } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { entitles, matchesInterest } from "@syncmesh/engine";
import { durationMs } from "@syncmesh/temporal";

import type { RoomState } from "./state.js";

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
 * grant it was seated under in a gated room (D40). One object so catch-up and live fan-out read
 * the same answer — through the socket's viewer, which also tells the socket what it was passed
 * over (passover.ts) — and so the connection that owns it stays about the protocol rather than
 * the gate.
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
   * The partitions this socket may put blobs into and be served them from (D44): the ones its
   * grant names, and none once that grant has lapsed (which hangs up, as {@link Seat.wants} does).
   * `undefined` in an open room, which checks neither.
   */
  readonly blobPartitions: () => readonly PartitionKey[] | undefined;
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

/** One socket's seat; `refuse` is the connection's fatal refusal. */
export function createSeat(room: RoomState, refuse: (code: string, message: string) => void): Seat {
  let interest: Interest | undefined;
  let granted: Grant | undefined;
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
  /**
   * The grant this seat may still be served under: the one it sat down with, or its renewal once
   * that lapses. `undefined` once neither holds — hung up, once, and quietly after that.
   */
  const ticket = (seated: Grant): Grant | undefined => {
    if (lapsedOut) return undefined;
    if (lapsed(room, seated)) granted = renewed(room, seated);
    if (granted === undefined) {
      lapsedOut = true;
      refuse(REVOKED, REVOKED_MESSAGE);
    }
    return granted;
  };

  return {
    take: (asked, grant) => {
      release();
      interest = asked;
      granted = grant;
      lapsedOut = false;
    },
    granted: () => granted,
    wants: (event) => {
      if (lapsedOut) return false;
      if (granted !== undefined) {
        const live = ticket(granted);
        if (live === undefined || !entitles(live.partitions, event)) return false;
      }
      return interest === undefined || matchesInterest(interest, event);
    },
    blobPartitions: () => {
      if (room.trust === undefined) return undefined;
      if (granted === undefined) return [];
      return ticket(granted)?.partitions ?? [];
    },
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

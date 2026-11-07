import type { Lsn } from "./lsn.js";

/**
 * Which position a slot may be told is flushed. Two kinds of position enter it, in stream
 * order: the end of a transaction delivered to the bridge, and the position of a keepalive
 * received while no transaction was open. A transaction's end is released only by an ack at or
 * past it; a keepalive position is released once every transaction before it is. So the
 * confirmed position never passes a transaction that was decoded and not acked, nor one that
 * was not decoded at all.
 */
export interface AckLedger {
  /** The newest position the slot may forget everything before. Never goes backwards. */
  readonly confirmed: () => Lsn;
  /** A transaction ending at `end` was delivered whole. */
  readonly delivered: (end: Lsn) => void;
  /** A keepalive at `end` arrived with no transaction open: the server sent everything before it. */
  readonly idle: (end: Lsn) => void;
  /** The bridge made everything up to `lsn` durable. `true` when that moved the confirmed position. */
  readonly ack: (lsn: Lsn) => boolean;
}

interface Pending {
  readonly lsn: Lsn;
  readonly commit: boolean;
}

const later = (a: Lsn, b: Lsn) => (a > b ? a : b);

export function createAckLedger(start: Lsn): AckLedger {
  let confirmed = start;
  const pending: Pending[] = [];
  return {
    confirmed: () => confirmed,
    delivered: (end) => void pending.push({ lsn: end, commit: true }),
    idle: (end) => {
      const last = pending.at(-1);
      // nothing delivered is unacked: everything before `end` was decoded and released
      if (last === undefined) confirmed = later(confirmed, end);
      else if (last.commit) pending.push({ lsn: end, commit: false });
      else pending[pending.length - 1] = { lsn: later(last.lsn, end), commit: false };
    },
    ack: (lsn) => {
      let released = confirmed;
      for (;;) {
        const front = pending[0];
        if (front === undefined || (front.commit && front.lsn > lsn)) break;
        pending.shift();
        released = later(released, front.lsn);
      }
      if (released === confirmed) return false;
      confirmed = released;
      return true;
    },
  };
}

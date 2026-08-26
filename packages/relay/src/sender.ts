/**
 * The rule from the load rig: `ws.send()` returning "not sent" on a full buffer is a future
 * hang unless every send goes through a queue. Order-preserving per-socket backlog, flushed
 * from the host's drain callback; at the ceiling the socket is closed, never trimmed —
 * a relay must never assume it can outrun a client.
 */

/** What actually happened to the frame: only "dropped" means it must be retried. */
export type SendOutcome = "sent" | "buffered" | "dropped";

/** One connection as the room sees it: an honest send and a way to hang up. */
export interface RelaySocket {
  readonly send: (frame: Uint8Array) => SendOutcome;
  readonly close: (reason?: string) => void;
}

export interface Sender {
  /** Queues behind any backlog; closes the socket when the backlog passes the ceiling. */
  readonly send: (frame: Uint8Array) => void;
  /** The host's socket drained: flush the backlog in order. */
  readonly drain: () => void;
  readonly backlog: () => number;
  readonly alive: () => boolean;
}

export function createSender(socket: RelaySocket, maxBacklog: number): Sender {
  const queued: Uint8Array[] = [];
  let dead = false;

  const overflow = (): void => {
    dead = true;
    queued.length = 0;
    socket.close("backlog ceiling: this client cannot keep up");
  };

  return {
    send: (frame) => {
      if (dead) return;
      if (queued.length > 0) {
        queued.push(frame);
        if (queued.length > maxBacklog) overflow();
        return;
      }
      if (socket.send(frame) === "dropped") queued.push(frame);
    },
    drain: () => {
      while (!dead && queued.length > 0) {
        // SAFETY: length checked above
        const next = queued[0] as Uint8Array;
        if (socket.send(next) === "dropped") return;
        queued.shift();
      }
    },
    backlog: () => queued.length,
    alive: () => !dead,
  };
}

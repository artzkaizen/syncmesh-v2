/**
 * The rule from the load rig: `ws.send()` returning "not sent" on a full buffer is a future
 * hang unless every send goes through a queue. Order-preserving per-socket backlog, flushed
 * from the host's drain callback; at the ceiling the socket is closed, never trimmed —
 * a relay must never assume it can outrun a client.
 *
 * Presence is the one exception to "never trimmed" (D16): a value a newer one supersedes is held
 * once per slot, never queued, so a stalled socket is handed the current cursor when it drains
 * rather than a backlog of dead ones — the relay's half of what `FrameLink.sendLatest` is on BLE.
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
  /**
   * Sends a value that a newer one for the same `slot` supersedes — presence. While the socket is
   * behind (a backlog, or a send the socket only buffered since its last drain) nothing goes into
   * the socket: the newest value per slot is held in its place, behind every ordinary frame, and
   * leaves on the next drain. Held values count towards neither ceiling, since there is at most
   * one per slot however fast they arrive. An absent slot — bytes that name none — is a `send`.
   */
  readonly sendLatest: (slot: string | undefined, frame: Uint8Array) => void;
  /** The host's socket drained: flush the backlog in order, then the newest value per slot. */
  readonly drain: () => void;
  /** Ordinary frames queued behind the socket; held latest values are not counted. */
  readonly backlog: () => number;
  /** Slots holding a value that has not left yet. */
  readonly held: () => number;
  readonly alive: () => boolean;
}

export function createSender(socket: RelaySocket, maxBacklog: number, maxBytes?: number): Sender {
  const queued: Uint8Array[] = [];
  /** The newest value per slot not yet handed to the socket, in the order the slots were first held. */
  const latest = new Map<string, Uint8Array>();
  let queuedBytes = 0;
  let dead = false;
  /**
   * The socket took a frame into its own buffer since the host last said it drained: what it
   * holds now is a queue this sender cannot trim, so a superseded value must not join it.
   */
  let pressured = false;

  const overflow = (): void => {
    dead = true;
    queued.length = 0;
    queuedBytes = 0;
    latest.clear();
    socket.close("backlog ceiling: this client cannot keep up");
  };

  const enqueue = (frame: Uint8Array): void => {
    queued.push(frame);
    queuedBytes += frame.byteLength;
    // frames alone are not a ceiling: a thousand near-cap blob frames is gigabytes of buffers
    if (queued.length > maxBacklog || (maxBytes !== undefined && queuedBytes > maxBytes))
      overflow();
  };

  /** One frame into the socket, and whether it left this sender's hands. */
  const put = (frame: Uint8Array): boolean => {
    const outcome = socket.send(frame);
    if (outcome === "buffered") pressured = true;
    return outcome !== "dropped";
  };

  /** The held values, oldest slot first, until the socket stops taking them without buffering. */
  const flushLatest = (): void => {
    for (const [slot, frame] of latest) {
      if (dead || pressured || queued.length > 0) return;
      if (!put(frame)) return;
      latest.delete(slot);
    }
  };

  const send = (frame: Uint8Array): void => {
    if (dead) return;
    if (queued.length > 0) {
      enqueue(frame);
      return;
    }
    if (!put(frame)) enqueue(frame);
  };

  return {
    send,
    sendLatest: (slot, frame) => {
      if (slot === undefined) {
        send(frame);
        return;
      }
      if (dead) return;
      // a slot already held keeps its place in line: a newer value takes the older one's
      if (pressured || queued.length > 0 || latest.size > 0) {
        latest.set(slot, frame);
        return;
      }
      if (!put(frame)) latest.set(slot, frame);
    },
    drain: () => {
      pressured = false;
      while (!dead && queued.length > 0) {
        // SAFETY: length checked above
        const next = queued[0] as Uint8Array;
        if (!put(next)) return;
        queued.shift();
        queuedBytes -= next.byteLength;
      }
      flushLatest();
    },
    backlog: () => queued.length,
    held: () => latest.size,
    alive: () => !dead,
  };
}

import type { FrameClass } from "./frame-parts.js";

/**
 * The sending order of one session. Frames offered within the same turn leave in **tag order**
 * rather than in the order they were written: grants before cursors, cursors before events,
 * events before the snapshot pages of a catch-up (E11, RFC-0012 "interactive vs bulk").
 *
 * The tag *is* the class. There is no second enum to keep in step with `KIND`, and no per-call
 * priority argument a call site could get wrong — a frame's class is the thing it already is.
 *
 * **This changes when a frame is sent, never whether.** Nothing here drops, coalesces or
 * reorders within a class: a frame that was offered is delivered, and two frames of one class
 * leave in the order they arrived. That last part is load-bearing twice over — the gap rule
 * needs an author's events in sequence, and the join exchange needs its manifest ahead of the
 * pages it names.
 *
 * Presence looks like the exception and is not. Conflation is real (D16, RFC-0012 §2) but it is
 * per `(topic, instance, peer)`, and a frame here is opaque bytes with no topic to read: two
 * pending presence frames are usually two different topics, and dropping one because another
 * arrived would lose a live value nothing supersedes. So the outbox orders presence and keeps
 * it, and conflation stays where the topic is known — `createPresenceStore`. What presence does
 * get is its place in the order: after the events, which is the class that yields under load.
 *
 * What it buys, once a link can be busy enough to have a queue at all (E12): a live event does
 * not wait behind a snapshot transfer, and a grant that would stop the far side quarantining
 * overtakes the events it authorises.
 */

/** One frame waiting, with the label its failure would be reported under. */
interface Pending {
  readonly what: string;
  readonly frame: Uint8Array;
}

export interface Outbox {
  /** Offers one frame under its own tag; it leaves at the next drain, ahead of higher tags. */
  readonly send: (cls: FrameClass, what: string, frame: Uint8Array) => void;
  /** Everything waiting goes now. The caller's way of flushing before a close or a test. */
  readonly drain: () => void;
}

/** Deliver at the end of the turn: near enough to now that nothing waits on a timer. */
const soon = (drain: () => void): void => queueMicrotask(drain);

/**
 * One outbox per link. `deliver` is the only thing that touches the medium, and it is handed
 * the class so a caller can decide what a failed send of *that* class means — a lost event is
 * an error worth reporting, a lost presence value is the correct outcome on a full radio.
 */
export function createOutbox(
  deliver: (cls: FrameClass, what: string, frame: Uint8Array) => void,
  schedule: (drain: () => void) => void = soon,
): Outbox {
  const waiting = new Map<FrameClass, Pending[]>();
  let scheduled = false;
  let draining = false;

  /** The lowest tag with anything waiting — re-read every step, so a grant queued mid-drain wins. */
  const lowest = (): FrameClass | undefined => {
    let best: FrameClass | undefined;
    for (const [cls, queue] of waiting)
      if (queue.length > 0 && (best === undefined || cls < best)) best = cls;
    return best;
  };

  const drain = (): void => {
    scheduled = false;
    // a send from inside `deliver` joins the queue this loop is already walking, rather than
    // starting a second one that would interleave with it
    if (draining) return;
    draining = true;
    try {
      for (let cls = lowest(); cls !== undefined; cls = lowest()) {
        const next = waiting.get(cls)?.shift();
        if (next !== undefined) deliver(cls, next.what, next.frame);
      }
    } finally {
      draining = false;
    }
  };

  return {
    send: (cls, what, frame) => {
      const queue = waiting.get(cls) ?? [];
      queue.push({ what, frame });
      waiting.set(cls, queue);
      if (draining || scheduled) return;
      scheduled = true;
      schedule(drain);
    },
    drain,
  };
}

import type { Unsubscribe } from "@syncmesh/engine";
import type { Temporal } from "@syncmesh/temporal";
import type { LinkEvent, LinkFact, TransportCondition } from "@syncmesh/transport";

import { createHub } from "@syncmesh/engine";

/**
 * A relay socket's link-level endings, said out loud (book ch. 18).
 *
 * Every framed medium gets this for free: `createFrameTransport` wraps the upgrader in
 * {@link reportingUpgrader}, and frame boundaries, the handshake and the door are all on the other
 * side of that seam. A relay has none of them — its session is a WebSocket and a versioned hello,
 * not a Noise handshake over a radio — so it builds its own `Transport` and, until this file, its
 * `onLinkEvent` was simply absent. Absent is a real answer in that contract: it means *this medium
 * cannot say*, which is what the Transports panel drew. So a device whose relay was not running
 * showed a medium with a condition of `unknown`, an empty ending feed and nothing anywhere that
 * said "could not reach ws://localhost:5236/issues" — the exact question the feed exists to answer.
 *
 * What a relay can honestly report is four of the five kinds. There is no `peer` on any of them:
 * the relay is store-and-forward and never announces a peer id, so naming one would be inventing
 * it. See {@link LinkEvent.peer}, which is optional for this case.
 */

/**
 * What this source is doing, derived from the last ending rather than declared.
 *
 * A verb per ending rather than one `note(fact)`, because the vocabulary is the relay's and the
 * caller should not be composing a `LinkFact` at each of six call sites — five of which would
 * repeat the same sentence the next reader has to check against the one above it.
 */
export interface LinkReport {
  /** A hello came back: the session is up and the versions agreed. */
  readonly proven: () => void;
  /** The relay said no, permanently. The close that follows carries the same reason. */
  readonly refused: (why: string) => void;
  /** A dial that never opened — the one ending a relay that is not running ever produces. */
  readonly undialled: (why: string) => void;
  /** Bytes that never became anything: an undecodable frame, an event that will not verify. */
  readonly dropped: (why: string) => void;
  /**
   * Something here decided to hang up, and the reason is left for the close that follows.
   *
   * By the time `onClose` runs the reason has gone, so it is kept here and cleared as it is read:
   * the next close is a different close, and inheriting this one's sentence is a lie that repeats.
   */
  readonly closing: (why: string) => void;
  /** The socket ended, for the reason `closing` left or for no reason anyone here knows. */
  readonly closed: () => void;
  readonly onLinkEvent: (cb: (event: LinkEvent) => void) => Unsubscribe;
  /**
   * Why this medium is not carrying, in the vocabulary a diagnostic screen already draws.
   *
   * `unknown` until something has happened, because a socket that has not been dialled yet has
   * not failed — and `temporarily-unavailable` over a transport that is mid-first-dial is a red
   * dot for a state nobody is in.
   */
  readonly condition: () => TransportCondition;
}

/** A dial that never opened, and a version the relay would not speak, are both "cannot connect". */
const CONDITION = {
  proven: "ok",
  error: "connecting-failed",
  refused: "connecting-failed",
  closed: "temporarily-unavailable",
} as const satisfies Partial<Record<LinkEvent["kind"], TransportCondition>>;

/**
 * A close only softens a source that was up.
 *
 * Every refusal also closes, and reading the close as the later fact would report a relay that
 * said *never* as one that is briefly away — which is the difference between a reconnect worth
 * waiting for and a build that has to be changed. So `temporarily-unavailable` is only ever
 * reached from a link that had been proved, or from a source nothing had said anything about yet.
 */
const softens = (current: TransportCondition): boolean => current === "ok" || current === "unknown";

/** The socket ended and nothing here asked it to: a network that went, or a relay that stopped. */
const CLOSED = "the relay socket closed";

export function createLinkReport(name: string, now: () => Temporal.Instant): LinkReport {
  const links = createHub<LinkEvent>();
  // widened on purpose: this starts at the one kind no ending produces and moves to whichever did
  let condition: TransportCondition = "unknown";
  let pending: string | undefined;

  const note = (fact: LinkFact): void => {
    // a dropped frame says nothing about the socket carrying it: the link is still up, and
    // moving the condition on one would draw a working relay as failed
    if (fact.kind === "closed") {
      if (softens(condition)) condition = CONDITION.closed;
    } else if (fact.kind !== "dropped") condition = CONDITION[fact.kind];
    links.emit({ ...fact, transport: name, at: now() });
  };

  return {
    // the relay never announces a peer id, so none of these name one rather than inventing it
    proven: () => note({ kind: "proven" }),
    refused: (why) => {
      note({ kind: "refused", why });
      pending = why;
    },
    undialled: (why) => note({ kind: "error", why }),
    dropped: (why) => note({ kind: "dropped", why }),
    closing: (why) => (pending = why),
    closed: () => {
      note({ kind: "closed", why: pending ?? CLOSED });
      pending = undefined;
    },
    onLinkEvent: links.subscribe,
    condition: () => condition,
  };
}

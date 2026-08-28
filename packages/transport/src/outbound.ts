import type { Engine, Hub, Interest, StoredEvent } from "@syncmesh/engine";
import type { Identity } from "@syncmesh/wire";

import { TaggedError } from "@syncmesh/result";
import { relayEnvelope, signEvent } from "@syncmesh/wire";

import type { FrameClass } from "./frame-parts.js";
import type { FrameLink } from "./link.js";

import { tableNames } from "./divergence.js";
import { KIND } from "./frame-parts.js";
import { cursorsFrame, digestFrame } from "./frame.js";
import { createOutbox } from "./outbox.js";

/**
 * The sending half of a session, and the two ways it can fail. Kept out of the bridge because
 * the two halves have almost nothing to say to each other: everything here turns state we
 * already hold into bytes, and everything there decides what arriving bytes mean.
 */

/** A relayed event whose author's signature was never stored cannot leave — nobody else can sign it. */
export class Unsendable extends TaggedError("Unsendable")<{ id: string; message: string }> {}

export class SendFailed extends TaggedError("SendFailed")<{ message: string; cause: unknown }> {}

export type BridgeError =
  | Unsendable
  | SendFailed
  | { readonly _tag: string; readonly message: string };

/** What one link sends, and the one place a send that failed becomes a reported error. */
export interface OutboundDeps {
  readonly link: FrameLink;
  readonly engine: Engine;
  readonly identity: Identity;
  readonly interest: Interest | undefined;
  readonly scope: string;
  readonly errors: Hub<BridgeError>;
}

/**
 * Everything one link sends, offered to the outbox under the class each frame already is. A
 * failure to send is reported rather than thrown — a loud failure is recoverable by resync, a
 * silent one is divergence (RFC-0005).
 */
export function createOutbound(deps: OutboundDeps) {
  const { link, engine, identity, interest, scope, errors } = deps;

  /** The one place a failed send becomes a value — and presence, the one class allowed to vanish. */
  const deliver = (cls: FrameClass, what: string, frame: Uint8Array): void => {
    try {
      link.send(frame);
    } catch (cause) {
      if (cls !== KIND.presence)
        errors.emit(new SendFailed({ message: `${what} did not leave`, cause }));
    }
  };
  const { send, drain } = createOutbox(deliver);

  /**
   * This device signs its own events, encoding them once as it signs; another peer's is relayed
   * as the bytes it arrived as, which `relayEnvelope` is the one place that decides.
   */
  const envelopeOf = (entry: StoredEvent): Uint8Array | undefined => {
    if (entry.event.peerId === identity.peerId) return signEvent(entry.event, identity).wire;
    const wire = relayEnvelope(entry);
    if (wire === undefined) {
      errors.emit(
        new Unsendable({ id: String(entry.event.id), message: "no stored signature to relay" }),
      );
    }
    return wire;
  };

  /**
   * What we hold, counted after the events we owed them have gone out and stamped with both halves
   * of where we stood when we counted — the cursors and what sits above them. Those are what let
   * the far side tell divergence from a peer that is merely a fold ahead or behind (D13).
   */
  const sendDigest = (): void =>
    send(
      KIND.digest,
      "digest",
      digestFrame(
        scope,
        engine.coverage().synced,
        tableNames(engine.digest(interest)),
        engine.ahead(),
      ),
    );

  /**
   * Our position — the contiguous cursors, and what we hold above them — sent once whatever the
   * caller is already doing has finished. The second half only narrows what the far side bothers
   * to send: a peer that ignores it re-sends a run we then skip.
   */
  const cursorsAfter = (queue: Promise<unknown>): Promise<void> =>
    queue.then(async () => {
      const cursors = await engine.cursors();
      if (cursors.isOk())
        send(KIND.cursors, "cursors", cursorsFrame(identity.peerId, cursors.value, engine.ahead()));
    });

  return { send, drain, envelopeOf, sendDigest, cursorsAfter };
}

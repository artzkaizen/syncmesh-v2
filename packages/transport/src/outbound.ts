import type { Engine, Hub, Interest, StoredEvent } from "@syncmesh/engine";
import type { Identity } from "@syncmesh/wire";

import { TaggedError } from "@syncmesh/result";
import { encodeCbor, encodeEventCore, signEvent } from "@syncmesh/wire";

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

  /** This device signs its own events; another peer's is relayed with the signature it came with. */
  const envelopeOf = (entry: StoredEvent): Uint8Array | undefined => {
    if (entry.event.peerId === identity.peerId) return signEvent(entry.event, identity).wire;
    if (entry.sig !== undefined) return encodeCbor([encodeEventCore(entry.event), entry.sig]);
    errors.emit(
      new Unsendable({ id: String(entry.event.id), message: "no stored signature to relay" }),
    );
    return undefined;
  };

  /**
   * What we hold, counted after the events we owed them have gone out and stamped with what we
   * had folded when we counted — the two facts that let the far side tell divergence from a peer
   * that is merely behind (E16).
   */
  const sendDigest = (): void =>
    send(
      KIND.digest,
      "digest",
      digestFrame(scope, engine.coverage().synced, tableNames(engine.digest(interest))),
    );

  /** Our contiguous position, sent once whatever the caller is already doing has finished. */
  const cursorsAfter = (queue: Promise<unknown>): Promise<void> =>
    queue.then(async () => {
      const cursors = await engine.cursors();
      if (cursors.isOk())
        send(KIND.cursors, "cursors", cursorsFrame(identity.peerId, cursors.value));
    });

  return { send, drain, envelopeOf, sendDigest, cursorsAfter };
}

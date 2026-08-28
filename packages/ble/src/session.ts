import type { PeerId } from "@syncmesh/kernel";
import type { FrameLink } from "@syncmesh/transport";
import type { Identity } from "@syncmesh/wire";

import { Result } from "@syncmesh/result";

import type { Hello, SessionKeys } from "./handshake.js";

import {
  HELLO,
  HandshakeFailed,
  ephemeralSecret,
  readHello,
  seal,
  sealNonce,
  sessionKeys,
  unseal,
  writeHello,
} from "./handshake.js";

/**
 * A `FrameLink` whose frames are encrypted, wrapped around one that is not.
 *
 * There is no plaintext path. A frame that is neither a hello nor sealed is dropped without
 * being looked at, which is what makes "encryption on" a property of the link rather than a
 * setting: a peer that skips the handshake is not talking to this device at all.
 *
 * Both ends open by sending a hello and neither waits for the other's, so the exchange costs one
 * round trip's latency and no ordering. Frames the bridge hands over before the key exists are
 * held, not dropped — the bridge sends its grants and cursors the moment it attaches, and losing
 * those would cost a whole resync for nothing.
 */

export interface SessionOptions {
  /** This device's Ed25519 keypair: what signs the ephemeral key, and what the peer id is. */
  readonly identity: Identity;
  /** A frame that went nowhere or arrived unreadable, for a log a person reads on a device. */
  readonly onDropped?: (why: string) => void;
  /**
   * The handshake will not complete — a bad signature, our own frame reflected, or more frames
   * held than a peer that is going to answer would ever need. The link is finished; the caller
   * tears it down and the next advertisement rebuilds it.
   */
  readonly onFailed?: (cause: unknown) => void;
  /** The peer's id, proven by its signature, the moment the session opens. */
  readonly onEstablished?: (peer: PeerId) => void;
  /** Frames held while the handshake runs. Past this the peer is not answering. */
  readonly maxPending?: number;
  /** Injected in tests, where a fixed key makes a frame comparable. */
  readonly secret?: () => Uint8Array;
  readonly nonce?: () => Uint8Array;
}

export const DEFAULT_MAX_PENDING = 64;

export function secureLink(link: FrameLink, options: SessionOptions): FrameLink {
  const { identity, onDropped, onFailed } = options;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const nonce = options.nonce ?? sealNonce;
  const listeners = new Set<(frame: Uint8Array) => void>();
  const pending: Uint8Array[] = [];
  const secret = (options.secret ?? ephemeralSecret)();
  const self = writeHello(identity, secret);
  let keys: SessionKeys | undefined;
  let failure: unknown;

  /** A failure here is the link's, not one frame's: nothing more can be sent or read. */
  const fail = (cause: unknown): void => {
    if (failure !== undefined) return;
    failure = cause;
    pending.length = 0;
    onFailed?.(cause);
  };

  /** Sends through the inner link, turning its throw into the link-level failure it is. */
  const put = (frame: Uint8Array): Result<void, unknown> =>
    Result.try({ try: () => link.send(frame), catch: (cause) => cause });

  const established = (peer: Hello, agreed: SessionKeys): void => {
    keys = agreed;
    const held = pending.splice(0);
    for (const frame of held) {
      const sent = put(seal(agreed.seal, frame, nonce()));
      if (sent.isErr()) return fail(sent.error);
    }
    options.onEstablished?.(peer.peerId);
  };

  const accept = (frame: Uint8Array): void => {
    if (keys !== undefined) {
      // including a second hello: nothing rekeys mid-session, so one can only be someone else's
      const opened = unseal(keys.open, frame);
      if (opened.isErr()) return onDropped?.(opened.error.message);
      for (const listener of listeners) listener(opened.value);
      return;
    }
    if (frame[0] !== HELLO) return onDropped?.("a frame arrived before the session was open");
    const peer = readHello(frame);
    if (peer.isErr()) return fail(peer.error);
    const agreed = sessionKeys(secret, self, peer.value);
    if (agreed.isErr()) return fail(agreed.error);
    established(peer.value, agreed.value);
  };

  const unsubscribe = link.onFrame((frame) => {
    if (failure !== undefined) return;
    accept(frame);
  });

  // ours goes out unprompted: the peer is doing the same, and whichever arrives first is fine
  const greeted = put(self.frame);
  if (greeted.isErr()) fail(greeted.error);

  return {
    send: (frame) => {
      if (failure !== undefined) throw failure;
      if (keys === undefined) {
        if (pending.length >= maxPending)
          throw new HandshakeFailed({
            message: `held ${maxPending} frames and the peer never said hello`,
          });
        pending.push(frame);
        return;
      }
      const sent = put(seal(keys.seal, frame, nonce()));
      if (sent.isErr()) throw sent.error;
    },
    onFrame: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    close: () => {
      unsubscribe();
      listeners.clear();
      pending.length = 0;
      link.close?.();
    },
  };
}

import type { PeerId } from "@syncmesh/kernel";
import type { Identity } from "@syncmesh/wire";

import { Result } from "@syncmesh/result";
import { bytesToHex } from "@syncmesh/wire";

import type { Hello, SessionKeys } from "./handshake.js";
import type { FrameLink } from "./link.js";

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
  /**
   * The same peer opened a *second* session over this link, and it replaced the first. Worth
   * saying out loud: it means the far side's half of the link died without anything reporting it.
   */
  readonly onSuperseded?: (peer: PeerId) => void;
  /** Frames held while the handshake runs. Past this the peer is not answering. */
  readonly maxPending?: number;
  /** Injected in tests, where a fixed key makes a frame comparable. */
  readonly secret?: () => Uint8Array;
  readonly nonce?: () => Uint8Array;
}

export const DEFAULT_MAX_PENDING = 64;

/**
 * How many of a link's past session keys are kept to refuse a replay with.
 *
 * A window rather than a whole history: see {@link secureLink}'s `offered`. Large enough that a
 * peer cycling its radio repeatedly never forgets a key while its replay could still be timely.
 */
export const KEYS_REMEMBERED = 64;

export function secureLink(link: FrameLink, options: SessionOptions): FrameLink {
  const { identity, onDropped, onFailed } = options;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const nonce = options.nonce ?? sealNonce;
  const listeners = new Set<(frame: Uint8Array) => void>();
  const pending: Uint8Array[] = [];
  const fresh = options.secret ?? ephemeralSecret;
  /**
   * The ephemeral keys this link has recently agreed a session under, newest last.
   *
   * What makes a replayed hello answerable. The frame that opens a session travels in the clear
   * — it must, since it is what the key is agreed from — so anyone who can see this link can keep
   * a copy of one, and a copy is signed exactly as well as the original. Offering a key this link
   * has already used is the one thing the peer itself would never do, so it is refused.
   *
   * **Bounded, because a link outlives the sessions on it.** Superseding is what keeps this object
   * alive across a peer's restarts, so the set grows for exactly as long as the feature works: a
   * radio that cycles twice an hour for a week is a set nobody ever empties. Remembering the last
   * {@link KEYS_REMEMBERED} costs the guard nothing real — a replay is answerable in the seconds
   * after it is captured, and a key evicted behind that many *later* sessions is one whose replay
   * would be refused by {@link supersede}'s freshness anyway.
   */
  const offered = new Set<string>();
  /** Records one agreed key, forgetting the oldest once the window is full. */
  const remember = (ephemeral: Uint8Array): void => {
    offered.add(bytesToHex(ephemeral));
    // `Set` iterates in insertion order, so the first key out is the oldest one in
    if (offered.size > KEYS_REMEMBERED) {
      const oldest = offered.values().next();
      if (!oldest.done) offered.delete(oldest.value);
    }
  };
  let secret = fresh();
  let self = writeHello(identity, secret);
  let keys: SessionKeys | undefined;
  /** Who this session proved, so a second hello can be held to being from the same device. */
  let proven: PeerId | undefined;
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
    proven = peer.peerId;
    remember(peer.ephemeral);
    const held = pending.splice(0);
    for (const frame of held) {
      const sent = put(seal(agreed.seal, frame, nonce()));
      if (sent.isErr()) return fail(sent.error);
    }
    options.onEstablished?.(peer.peerId);
  };

  /**
   * A hello on a session that is already open: the peer's half of this link is gone, and this is
   * the only thing that ever says so.
   *
   * **A medium does not always report that a link ended.** Cycle a phone's Bluetooth and its
   * peer's stack is told nothing about any connection — so the peer goes on holding a session,
   * keyed to an ephemeral secret the device that restarted has thrown away, and every frame the
   * new session sends arrives as `not a sealed frame` for as long as both devices are switched
   * on. Measured on a three-phone chain: whichever device cycled ended at `reaches() === 0` while
   * its neighbours went on claiming it. A second hello is the far side saying, in the only
   * vocabulary this layer has, that it has started again — and the session it started is the one
   * worth keeping, because it is the one both ends can read.
   *
   * **Only from the device the live session already proved.** The hello is verified exactly as
   * the first one was and its peer id must equal the one on this session, so a stranger cannot
   * take a link off the peer it belongs to: displacing a session means producing a signature
   * under the Ed25519 key that *is* that peer id, which is to say being that peer.
   *
   * The attack that remains is replay. A hello travels in the clear, so anyone who can see this
   * link can keep a copy and offer it back later — a signed frame, from the right peer, and this
   * layer cannot date it. {@link offered} refuses the cheap form of that, a copy of the very
   * frame this session was agreed under. What a replay of some *other* session's hello can still
   * do is break this link: the key would be agreed against an ephemeral whose secret nobody
   * present holds, and neither end could read the other until something re-established it. It
   * buys nothing else — not a frame read, not a frame forged, not a peer impersonated — and it
   * is available only to an attacker already able to put frames on this link, who could as
   * easily drop them. A link somebody standing on the wire can break is the better half of the
   * trade: refusing to rekey does not prevent that attacker, and does guarantee that every radio
   * switched off and on again strands a pair of devices until one of them is restarted.
   */
  const supersede = (frame: Uint8Array): void => {
    const peer = readHello(frame);
    if (peer.isErr()) return onDropped?.(peer.error.message);
    if (peer.value.peerId !== proven)
      return onDropped?.(
        `${peer.value.peerId.slice(0, 8)} offered a session on a link held by ${proven?.slice(0, 8) ?? "nobody"}`,
      );
    if (offered.has(bytesToHex(peer.value.ephemeral)))
      return onDropped?.("a hello this link has already agreed a session under, offered again");
    // ours is fresh too: the peer discarded the secret behind the key it had from us, and
    // agreeing the new session under the old one would carry a dead link's material into a live one
    secret = fresh();
    self = writeHello(identity, secret);
    const agreed = sessionKeys(secret, self, peer.value);
    if (agreed.isErr()) return fail(agreed.error);
    // unsealed, and before the keys change: it is what the far side agrees its half from, and it
    // is waiting for it — its own hello was the first thing its new session sent
    const greeted = put(self.frame);
    if (greeted.isErr()) return fail(greeted.error);
    keys = agreed.value;
    remember(peer.value.ephemeral);
    options.onSuperseded?.(peer.value.peerId);
  };

  const accept = (frame: Uint8Array): void => {
    if (keys !== undefined) {
      // a second hello is the peer starting over on a link nothing told us had ended
      if (frame[0] === HELLO) return supersede(frame);
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

import type { PeerId } from "@syncmesh/kernel";
import type { Identity } from "@syncmesh/wire";

import { speaksHandshake } from "./frames.js";
import { isHello, secureLink, type SecureLink } from "./secure.js";

const UNPINNED =
  "the relay's hello is signed by a key other than the one this device was told to expect";

/** What a device's relay link does with what its sealing decides. */
export interface LinkSealHooks {
  /** The relay refused this device for good; absent `why`, it refused the protocol version. */
  readonly refused: (why?: string) => void;
  /** This session cannot go on, though the next one may. */
  readonly hangUp: (why: string) => void;
  /** Our hello, in the clear and ahead of everything else; `false` when it did not leave. */
  readonly sendHello: (hello: Uint8Array) => boolean;
  /** The link is ready for a join. */
  readonly join: () => void;
}

export interface LinkSealOptions {
  readonly versions: readonly number[];
  /** The one key a room's hello may be signed by (D36); absent, any well-signed hello opens. */
  readonly relayKey: PeerId | undefined;
  readonly hooks: LinkSealHooks;
}

/**
 * One socket's sealing, on a device's relay link (D33, D36): the sealed link from the room's hello
 * on, or the room's challenge when it challenges instead. Neither, until the room's first frame.
 */
export interface LinkSeal {
  /** Forgets the last socket's sealing, for a fresh one. */
  readonly reset: () => void;
  /** The room challenged this socket (D33); a v2 join proves this nonce. */
  readonly challenged: (nonce: Uint8Array) => void;
  /** A frame as it goes out: sealed on a sealed link, as it is otherwise, `undefined` when a sealed link has no key yet. */
  readonly seal: (frame: Uint8Array) => Uint8Array | undefined;
  /**
   * Whether a join may go now: on a sealed link once the session exists, on a challenging room
   * once the challenge has arrived, carrying the nonce it proves. `undefined` until then.
   */
  readonly joinable: () => { readonly nonce: Uint8Array | undefined } | undefined;
  /**
   * Raw socket bytes to the frames the session reads. The room's first frame says which protocol
   * it speaks: a hello opens a sealed link, and our hello answers it in the clear before anything
   * else; a CBOR frame is a challenging room, whose frames arrive as they are.
   */
  readonly open: (
    identity: Identity,
    raw: Uint8Array,
    deliver: (frame: Uint8Array) => void,
  ) => void;
}

/** A sealing with neither a link nor a challenge yet. */
export function createLinkSeal(options: LinkSealOptions): LinkSeal {
  const { versions, relayKey, hooks } = options;
  let link: SecureLink | undefined;
  let nonce: Uint8Array | undefined;

  const hello = (identity: Identity, raw: Uint8Array): void => {
    if (!speaksHandshake(versions)) {
      hooks.refused();
      return;
    }
    const offered = secureLink(identity);
    const opened = offered.receive(raw);
    if (opened.isErr()) {
      hooks.hangUp(opened.error.message);
      return;
    }
    // pinned: the hello proved *a* key; it has to be *the* key, or this is not our relay
    if (relayKey !== undefined && offered.session()?.peer !== relayKey) {
      hooks.refused(UNPINNED);
      return;
    }
    link = offered;
    // our hello answers the room's, in the clear; it is the last thing that travels so
    if (offered.hello !== undefined && !hooks.sendHello(offered.hello)) return;
    hooks.join();
  };

  return {
    reset: () => {
      link = undefined;
      nonce = undefined;
    },
    challenged: (value) => void (nonce = value),
    seal: (frame) => (link === undefined ? frame : link.seal(frame)),
    joinable: () => {
      if (link !== undefined)
        return link.session() === undefined ? undefined : { nonce: undefined };
      return nonce === undefined ? undefined : { nonce };
    },
    open: (identity, raw, deliver) => {
      if (link === undefined) {
        if (isHello(raw)) hello(identity, raw);
        else deliver(raw);
        return;
      }
      const opened = link.receive(raw);
      if (opened.isErr()) hooks.hangUp(opened.error.message);
      else if (opened.value !== undefined) deliver(opened.value);
    },
  };
}

import type { PeerId } from "@syncmesh/kernel";
import type { SessionKeys } from "@syncmesh/transport";
import type { Identity } from "@syncmesh/wire";

import { Result, TaggedError } from "@syncmesh/result";
import {
  HELLO,
  HELLO_BYTES,
  ephemeralSecret,
  readHello,
  seal,
  sealNonce,
  sessionKeys,
  unseal,
  writeHello,
  type Hello,
} from "@syncmesh/transport";

/**
 * The relay link runs the link handshake (D36, D33's option C).
 *
 * Every radio link already does this: each end signs a fresh X25519 key with the Ed25519 key
 * that *is* its peer id, the two agree a session key from the pair, and everything after the two
 * hellos travels sealed. The relay socket used to skip it and borrow confidentiality from `wss://`
 * and identity from a challenge (D33). Now the socket is a link like any other: the room learns
 * who is on it from the hello — so the join no longer has to prove anything — and the bytes it
 * forwards are opened and re-sealed per socket, so a middle that is not the relay reads nothing.
 *
 * One state machine for both ends, because a room and a device have exactly the same three
 * facts to keep: the hello they offered (and the secret behind it) until the peer's arrives, and
 * the session once it has. A host that sleeps between those two moments hands them back through
 * {@link SecureLinkOptions}; nothing here holds a timer or a socket.
 */

/** What a sealed relay link has agreed: the two directional keys, and who is on the far end. */
export interface LinkSession {
  readonly peer: PeerId;
  readonly keys: SessionKeys;
}

/** What an end that has offered its hello and heard nothing back must keep to finish later. */
export interface LinkOffer {
  readonly secret: Uint8Array;
  readonly hello: Uint8Array;
}

export interface SecureLinkOptions {
  /** An offer made before — a host that slept between its own hello and the peer's. */
  readonly offer?: LinkOffer;
  /** A session already agreed — a host that slept after the handshake. */
  readonly session?: LinkSession;
  /** The per-frame nonce; injected by tests and vectors, random everywhere else. */
  readonly nonce?: () => Uint8Array;
}

/**
 * Why a link refused a frame. `handshake` is the first frame not being a well-signed hello;
 * `unsealed` a plaintext frame after the handshake, which is a downgrade and not a mistake;
 * `unopenable` a sealed frame this link's key does not open — another link's traffic, or
 * tampering, and from here the two are the same fact.
 */
export class LinkRefused extends TaggedError("LinkRefused")<{
  code: "handshake" | "unsealed" | "unopenable";
  message: string;
}> {}

export interface SecureLink {
  /** Our hello, to go out first and in the clear; `undefined` when the session was restored. */
  readonly hello: Uint8Array | undefined;
  /** What to keep while the peer's hello is still outstanding; `undefined` once it has arrived. */
  readonly offer: () => LinkOffer | undefined;
  readonly session: () => LinkSession | undefined;
  /**
   * A raw frame in. Before the handshake it must be the peer's hello, which completes the
   * exchange and yields nothing to deliver; after it, a sealed frame, which yields its plaintext.
   */
  readonly receive: (raw: Uint8Array) => Result<Uint8Array | undefined, LinkRefused>;
  /** Plaintext out as a sealed frame, or `undefined` before there is a key to seal under. */
  readonly seal: (plain: Uint8Array) => Uint8Array | undefined;
}

/** Whether these bytes are shaped like a hello: the one frame that is never CBOR on this wire. */
export const isHello = (raw: Uint8Array): boolean => raw.length === HELLO_BYTES && raw[0] === HELLO;

const refused = (code: LinkRefused["code"], message: string) =>
  Result.err(new LinkRefused({ code, message }));

export function secureLink(identity: Identity, options: SecureLinkOptions = {}): SecureLink {
  const nonce = options.nonce ?? sealNonce;
  let session: LinkSession | undefined = options.session;
  /** Our side of the exchange, until the peer's hello turns it into a session. */
  let pending: { readonly secret: Uint8Array; readonly self: Hello } | undefined;
  if (session === undefined) {
    const secret = options.offer?.secret ?? ephemeralSecret();
    const self =
      options.offer === undefined
        ? writeHello(identity, secret)
        : // the frame as it went out, because both ends hash the pair and the exact bytes matter
          readHello(options.offer.hello).match({
            ok: (hello) => hello,
            err: () => writeHello(identity, secret),
          });
    pending = { secret, self };
  }

  const complete = (raw: Uint8Array): Result<undefined, LinkRefused> => {
    if (pending === undefined) return refused("handshake", "the link is already secured");
    const peer = readHello(raw);
    if (peer.isErr()) return refused("handshake", peer.error.message);
    const keys = sessionKeys(pending.secret, pending.self, peer.value);
    if (keys.isErr()) return refused("handshake", keys.error.message);
    session = { peer: peer.value.peerId, keys: keys.value };
    pending = undefined;
    return Result.ok(undefined);
  };

  return {
    hello:
      options.session === undefined && options.offer === undefined
        ? pending?.self.frame
        : undefined,
    offer: () =>
      pending === undefined ? undefined : { secret: pending.secret, hello: pending.self.frame },
    session: () => session,
    receive: (raw) => {
      if (session === undefined) return complete(raw);
      if (!isHello(raw) && raw[0] !== 0x02)
        return refused("unsealed", "a frame in the clear on a sealed link");
      const opened = unseal(session.keys.open, raw);
      return opened.isErr() ? refused("unopenable", opened.error.message) : Result.ok(opened.value);
    },
    seal: (plain) => (session === undefined ? undefined : seal(session.keys.seal, plain, nonce())),
  };
}

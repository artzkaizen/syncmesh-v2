import type { PeerId } from "@syncmesh/kernel";
import type { Identity } from "@syncmesh/wire";

import type { Bridge } from "./bridge.js";
import type { ByteStream } from "./framing.js";
import type { AdmissionAsk } from "./gate.js";
import type { FrameLink } from "./link.js";

import { framed } from "./framing.js";
import { secureLink } from "./session.js";

/**
 * Everything that happens between "the medium handed me a channel" and "the bridge is talking
 * over it": frame boundaries, the session handshake, the door, and the attach.
 *
 * It is one seam and not four steps in each adapter because **the adapters were each doing all
 * four, and the only thing making every link encrypted was that the same three lines had been
 * written out four times.** A transport's job is to produce a channel to a peer; whether that
 * channel is safe to carry a mesh over is not a fact about the medium, and an adapter that could
 * forget it is an adapter that eventually will.
 *
 * The shape is libp2p's `Upgrader`, which a transport cannot bypass for the same reason: there,
 * `dial` returns a raw `MultiaddrConnection` and the framework turns it into a `Connection`.
 *
 * **Two ways in, because there are two kinds of medium.** A socket and a Wi-Fi data path hand
 * over bytes, and the length prefix puts boundaries back. A radio that fragments below this line
 * hands over whole frames already, and framing them again would be paying twice.
 */

export interface Upgraded {
  /** Who the handshake proved is there; `undefined` until it has, and after a refusal. */
  readonly peer: () => PeerId | undefined;
  readonly close: () => void;
}

export interface UpgradeOptions {
  /**
   * Who the medium's announcement said would be there.
   *
   * A claim and never a fact — a BLE hint is a lossy prefix, a LAN announcement is a datagram
   * anyone can send, and service information is whatever a peer chose to publish. It is used for
   * two things only: the cheap refusal before a dial is spent, and a readable log line.
   */
  readonly claimed?: PeerId;
  /** The handshake proved who is there. What an adapter's `reaches()` is built from. */
  readonly onProven?: (peer: PeerId) => void;
  /**
   * The same peer handshook again over this link and the new session replaced the old one — see
   * `secureLink`. Nothing for an adapter to do: the peer, the link and the bridge are the ones it
   * already has. Worth hearing, because it is the only evidence anywhere that the far side's half
   * of a link died with nothing reporting it.
   */
  readonly onSuperseded?: (peer: PeerId) => void;
  /** This link is over — a failed handshake, a closed door, or the medium going away. */
  readonly onClosed?: (why: string) => void;
  /**
   * The door refused this peer, after the handshake named it.
   *
   * Separate from {@link onClosed} because it is the one ending worth **remembering**. A medium
   * that forgets it pays the whole cost again on the peer's next announcement — and a stranger
   * in a lobby announces every second or two, for as long as it is there. One refused connection
   * is the price of not knowing; a thousand is a bug.
   */
  readonly onRefused?: (peer: PeerId) => void;
  /** A per-link frame cap, where the medium wants one tighter than the default. */
  readonly maxFrameBytes?: number;
}

export interface Upgrader {
  /** A medium that streams bytes: a socket, a Wi-Fi Aware data path, an AWDL link. */
  readonly bytes: (stream: ByteStream, options?: UpgradeOptions) => Upgraded;
  /** A medium that already delivers whole frames, because it fragments below this line. */
  readonly frames: (link: FrameLink, options?: UpgradeOptions) => Upgraded;
}

export interface UpgraderDeps {
  readonly identity: Identity;
  /** The transport's name, for the door's ask and for a log a person reads. */
  readonly transport: string;
  readonly attach: (link: FrameLink, peer: PeerId) => Bridge;
  /** The door, asked once the handshake has named the peer (book ch. 14). */
  readonly admits?: (ask: AdmissionAsk) => Promise<boolean>;
  readonly onDropped?: (why: string) => void;
}

/**
 * A link that holds what arrives until somebody is listening, then hands it over in order.
 *
 * The gap it covers is real and small: the peer is proved, the door has not answered yet, and
 * the far side — whose own handshake finished a moment earlier — is already sending its grants
 * and cursors. Dropping those is not fatal, because the bridge re-exchanges on attach, but it
 * costs a round trip on every link for no reason, and "not fatal" is a poor thing to build on.
 */
const heldUntilRead = (link: FrameLink): FrameLink => {
  const waiting: Uint8Array[] = [];
  let sink: ((frame: Uint8Array) => void) | undefined;
  const off = link.onFrame((frame) => {
    if (sink === undefined) return void waiting.push(frame);
    sink(frame);
  });
  return {
    send: (frame) => link.send(frame),
    onFrame: (cb) => {
      sink = cb;
      const held = waiting.splice(0);
      for (const frame of held) cb(frame);
      return () => (sink = undefined);
    },
    close: () => {
      off();
      link.close?.();
    },
  };
};

export function createUpgrader(deps: UpgraderDeps): Upgrader {
  const upgrade = (link: FrameLink, options: UpgradeOptions): Upgraded => {
    const who = options.claimed?.slice(0, 8) ?? "an inbound peer";
    let peer: PeerId | undefined;
    let bridge: Bridge | undefined;
    let closed = false;

    /**
     * Declared before {@link close} and assigned after, because the handshake can fail *during*
     * construction.
     *
     * `secureLink` sends its hello before it returns (`session.ts`), so a link that is already
     * dead — a socket closed between dial and upgrade, a radio switched off mid-handshake — takes
     * the `onFailed` path, which calls `close`, which reached `session` while its `const` was
     * still in the temporal dead zone: `ReferenceError: Cannot access 'session' before
     * initialization`, thrown out of a failure handler and replacing the real reason with a crash.
     *
     * `undefined` here is therefore a real state and not a formality: it means the session never
     * got far enough to have anything to close.
     */
    let session: ReturnType<typeof secureLink> | undefined;

    const close = (why: string): void => {
      if (closed) return;
      closed = true;
      peer = undefined;
      bridge?.close();
      session?.close?.();
      options.onClosed?.(why);
    };

    session = secureLink(link, {
      identity: deps.identity,
      ...(deps.onDropped !== undefined && { onDropped: deps.onDropped }),
      /**
       * The peer signed for its id, so this link now reaches it — and only now is it attachable
       * under a name. Attaching before this would hand one peer's conversation to whoever
       * answered the dial.
       */
      onEstablished: (proven) => {
        peer = proven;
        options.onProven?.(proven);
        void admitted(proven);
      },
      /**
       * Reported, and nothing more. The door was asked about this peer when the link first
       * proved it and the bridge is still the bridge for that conversation — attaching a second
       * one here would put two sessions on one link, and asking the door again would be asking
       * it to answer twice about a device that never left.
       */
      ...(options.onSuperseded !== undefined && { onSuperseded: options.onSuperseded }),
      onFailed: (cause) => close(`the session with ${who} failed: ${String(cause)}`),
    });

    /** The held end, so nothing the far side says between the handshake and the door is lost. */
    const buffered = heldUntilRead(session);

    const admitted = async (proven: PeerId): Promise<void> => {
      const allowed = await deps.admits?.({ peer: proven, transport: deps.transport });
      if (closed) return;
      // deny is retry-after-backoff and never a verdict: the next sighting asks again, and a
      // grant or a policy that lands a moment later heals the mesh with no rendezvous
      if (allowed === false) {
        options.onRefused?.(proven);
        return close(`${proven.slice(0, 8)} was not admitted here`);
      }
      bridge = deps.attach(buffered, proven);
    };

    return { peer: () => peer, close: () => close("the medium closed this link") };
  };

  return {
    bytes: (stream, options = {}) => {
      const link = framed(stream, {
        ...(deps.onDropped !== undefined && { onDropped: deps.onDropped }),
        ...(options.maxFrameBytes !== undefined && { maxFrameBytes: options.maxFrameBytes }),
      });
      const upgraded = upgrade(link, options);
      stream.onClose(() => upgraded.close());
      return upgraded;
    },
    frames: (link, options = {}) => upgrade(link, options),
  };
}

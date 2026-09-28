import type { ByteStream } from "@syncmesh/transport";

import { TaggedError } from "@syncmesh/result";

/**
 * The network this transport needs, and nothing more.
 *
 * Two halves, because a LAN has two: announcements go to a multicast group, where they are cheap
 * and unreliable and nobody minds; frames go over a stream, which is what an ordered, lossless
 * link is called on this medium. A datagram carrying frames would lose one silently, and a
 * silently lost frame is divergence rather than a resync (RFC-0005).
 *
 * `@syncmesh/lan-node` satisfies this with `dgram` and `net`, and is not imported: taking the
 * network by injection is what lets everything here be tested with no socket, no multicast group
 * and no permissions dialog — the same reason `@syncmesh/ble` takes a radio and `packages/relay`
 * takes a `dial`. It also means this package holds no opinion about which module supplies the
 * bytes, only about their shape.
 */

export type Unsubscribe = () => void;

/** Where a peer can be reached. Not an identity: the handshake establishes that, as everywhere. */
export interface LanAddress {
  readonly host: string;
  readonly port: number;
}

/** The network is not there: no interface up, the group unjoinable, the socket already closed. */
export class LanUnavailable extends TaggedError("LanUnavailable")<{
  message: string;
}> {}

/** This platform has no such adapter — named, so a device can say which fast path it lacks. */
export class LanUnsupported extends TaggedError("LanUnsupported")<{
  adapter: string;
  message: string;
}> {}

/**
 * One open connection to one peer on this network. A TCP socket, here — and a {@link ByteStream}
 * like every other, because a Wi-Fi Aware data path and an AWDL link are the same shape and the
 * length prefix that puts frame boundaries back must be one implementation, not three.
 */
export type LanStream = ByteStream;

export interface LanNetwork {
  /** Puts one announcement on the group. Lossy by nature: they repeat, so a lost one costs a beat. */
  readonly announce: (bytes: Uint8Array) => void;
  readonly onAnnouncement: (cb: (bytes: Uint8Array, from: LanAddress) => void) => Unsubscribe;
  /** Where peers should dial this device — what an announcement carries. */
  readonly address: () => LanAddress;
  readonly dial: (to: LanAddress) => Promise<LanStream>;
  /** A peer dialled us: the other half of {@link dial}, and the half that does not choose. */
  readonly onConnection: (cb: (stream: LanStream) => void) => Unsubscribe;
  readonly close: () => Promise<void>;
}

/**
 * Where announcements go by default: an administratively-scoped multicast group, which is the
 * range routers are required not to forward off the local network. The room stays the room.
 */
export const DEFAULT_GROUP: LanAddress = { host: "239.255.71.67", port: 47_167 };

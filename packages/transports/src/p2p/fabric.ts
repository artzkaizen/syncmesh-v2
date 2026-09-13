import type { PeerId } from "@syncmesh/kernel";
import type { ByteStream, Unsubscribe } from "@syncmesh/transport";

import { TaggedError } from "@syncmesh/result";

/**
 * The peer-to-peer Wi-Fi this transport needs, and nothing more.
 *
 * There is no access point here and no address to dial. The platform publishes a service, tells
 * you which peers are running the same one, and opens a data path to one of them on request —
 * so what a peer *is*, to this package, is an opaque handle the platform hands back and takes
 * again. Anything more specific would be one platform's vocabulary in a port two of them satisfy.
 *
 * Taking the fabric by injection is what lets everything here be tested with no hardware, no
 * simulator and no permissions dialog, the same way `@syncmesh/ble` takes a radio.
 */

/**
 * Which protocol a fabric speaks, checked where the adapter is built.
 *
 * **AWDL and Wi-Fi Aware do not interoperate.** An iPhone speaking AWDL and an Android phone
 * speaking Wi-Fi Aware never link, so a fabric handed to the wrong adapter is a mesh that looks
 * configured and finds nobody — which is exactly the failure a merged `p2pWifi` would hide.
 */
export type P2pProtocol = "awdl" | "wifi-aware";

/** This device cannot speak the protocol the adapter was asked for, and says which. */
export class P2pUnsupported extends TaggedError("P2pUnsupported")<{
  /** The adapter that could not be built: `awdl` or `wifiAware`. */
  adapter: string;
  message: string;
}> {}

/** A data path that would not open. Ordinary on this medium: peers wander out of range mid-dial. */
export class P2pPathFailed extends TaggedError("P2pPathFailed")<{
  message: string;
}> {}

/**
 * A peer the platform is currently reporting.
 *
 * `id` is the platform's handle, stable only while the peer stays discovered — it is not an
 * identity and must not be treated as one. `announces` is what the peer put in its service
 * information, which is where this package puts a peer id so that both ends can decide who
 * opens the path; the handshake is still what proves it.
 */
export interface P2pPeer {
  readonly id: string;
  readonly announces: Uint8Array;
}

export interface P2pFabric {
  /** What this fabric actually speaks. The adapter refuses a mismatch rather than finding nobody. */
  readonly protocol: P2pProtocol;
  /**
   * Starts publishing and subscribing under one service name, carrying `announces` for anyone
   * who finds it. Both roles at once, because a mesh of phones needs both.
   */
  readonly publish: (service: string, announces: Uint8Array) => Promise<void>;
  readonly onPeerFound: (cb: (peer: P2pPeer) => void) => Unsubscribe;
  readonly onPeerLost: (cb: (id: string) => void) => Unsubscribe;
  /** Opens a data path to a discovered peer. Rejects when the platform will not, which is often. */
  readonly connect: (id: string) => Promise<ByteStream>;
  /** A peer opened a path to us: the other half of {@link connect}, and the half that does not choose. */
  readonly onPath: (cb: (stream: ByteStream, from: string) => void) => Unsubscribe;
  readonly stop: () => Promise<void>;
}

/** The service both ends must name identically, or the platform never reports them to each other. */
export const serviceName = (room: string, protocol: P2pProtocol): string =>
  `syncmesh-${protocol}-${room}`;

/** What a peer puts in its service information: the id both ends compare to decide who connects. */
export const announces = (peer: PeerId): Uint8Array => new TextEncoder().encode(peer);

/** The peer id a sighting claims, or `undefined` when it is not one. A claim, never a fact. */
export const claimedBy = (peer: P2pPeer): string | undefined => {
  const claim = new TextDecoder().decode(peer.announces);
  return /^[\da-f]{64}$/.test(claim) ? claim : undefined;
};

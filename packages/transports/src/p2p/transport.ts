import type { PeerId } from "@syncmesh/kernel";
import type { ByteStream, Transport, TransportCondition, Upgraded } from "@syncmesh/transport";

import { parsePeerId } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";
import { createBackoff, createFrameTransport, shouldDial } from "@syncmesh/transport";

import type { P2pFabric, P2pProtocol } from "./fabric.js";

import { announces, claimedBy, serviceName } from "./fabric.js";

/**
 * Peer-to-peer Wi-Fi as a transport: the fast path with no access point in it (book ch. 16).
 *
 * Two adapters are built from this and they are deliberately two — {@link awdl} and
 * {@link wifiAware}. The code is shared because the shape is shared: publish a service, hear who
 * else is running it, open a data path, hand the bytes to a session. What is *not* shared is
 * which radio protocol is on the wire, and that is the fact a mixed fleet has to be able to read
 * off `$status`, so each adapter keeps its own `kind`, its own service name and its own fabric.
 *
 * Everything above a link is the bridge's. This file owns only what is true of peer-to-peer
 * Wi-Fi: who is nearby, who opens the path, and where an arriving byte belongs.
 *
 * Every link is encrypted, with no setting that says otherwise. Anyone in the room can publish
 * the same service.
 */

export interface P2pOptions {
  /** The room. Two apps in one café are two meshes, and the service name is what keeps them apart. */
  readonly id: string;
  readonly fabric: P2pFabric;
  readonly name?: string;
  readonly maxFrameBytes?: number;
  /** A path or a frame that went nowhere, for a log a person reads on a device. */
  readonly onDropped?: (why: string) => void;
  /**
   * Concurrent data paths this radio sustains. A Wi-Fi Aware device negotiates a small number of
   * them and degrades every one past that; present because the number is not one number across
   * every phone, not because an app has a view.
   */
  readonly maxLinks?: number;
}

/**
 * What a peer-to-peer Wi-Fi link moves, near enough (RFC-0012 §2). Nominal: the scorer needs the
 * ratio to a radio and to a relay, not a measurement. Below a shared access point because these
 * links negotiate a duty cycle rather than holding a channel.
 */
export const P2P_BANDWIDTH_BPS = 8_000_000;

/** What one of these radios sustains before every path degrades. Not a setting an app improves. */
export const DEFAULT_MAX_LINKS = 4;

interface Held {
  readonly link: Upgraded;
  /** Who the service information said would be there. A claim, not a fact — see `proven`. */
  readonly claimed?: string | undefined;
}

/** The shared body; `awdl` and `wifiAware` are the two names it is reachable under. */
/** The announced id as a peer id, when it is one — what the door's cheap rung is given. */
const claimedPeer = (claimed: string | undefined): PeerId | undefined => {
  if (claimed === undefined) return undefined;
  const peer = parsePeerId(claimed);
  return peer.isOk() ? peer.value : undefined;
};

const p2pTransport = (protocol: P2pProtocol, adapter: string, options: P2pOptions): Transport => {
  const { fabric } = options;
  // outside anything async: a fabric for the other protocol finds nobody and looks like a quiet
  // room, which is the one failure two adapters exist to prevent
  if (fabric.protocol !== protocol)
    panic(
      `${adapter}() was given a ${fabric.protocol} fabric: these protocols do not interoperate`,
    );

  const held = new Map<string, Held>();
  /**
   * The peer on each path, and only once the handshake has proved it. Service information is
   * whatever the peer chose to publish, so claiming to reach a peer on the strength of it would
   * be routing a frame at a signature nobody checked (E28).
   */
  const proven = new Map<string, PeerId>();
  const drop = (why: string) => options.onDropped?.(why);
  let condition: TransportCondition = "ok";
  let closePath = (id: string): void => void id;

  const transport = createFrameTransport({
    name: options.name ?? adapter,
    kind: protocol,
    condition: () => condition,
    ...(options.onDropped !== undefined && { onDropped: options.onDropped }),
    /** Direct, wide, and expensive: these radios hold a duty cycle and cost power to do it. */
    route: () => ({ direct: true, bandwidthBps: P2P_BANDWIDTH_BPS, costly: true }),
    open: async (ctx, _attach, upgrade, mayDial) => {
      const self = ctx.identity.peerId;
      const backoff = createBackoff();
      /**
       * Peers this device is opening a path to right now.
       *
       * The platform reports a peer for as long as it is there, not once — so without this, the
       * second report arrives while the first `connect` is still awaiting and opens a second
       * path to the same device. One of the two then has no reader on the far end, because the
       * far end already accepted the other, and every frame written to it is lost.
       */
      const opening = new Set<string>();

      closePath = (id) => {
        const entry = held.get(id);
        if (entry === undefined) return;
        held.delete(id);
        proven.delete(id);
        entry.link.close();
      };

      /**
       * A data path handed to the upgrader, remembered by the platform's own handle.
       *
       * Boundaries, the handshake and the door are the upgrader's. What is left here is what is
       * actually this radio's: which paths exist, and who the service information claimed.
       */
      const hold = (id: string, stream: ByteStream, claimed?: string): void => {
        const announced = claimedPeer(claimed);
        const link = upgrade.bytes(stream, {
          ...(announced !== undefined && { claimed: announced }),
          ...(options.maxFrameBytes !== undefined && { maxFrameBytes: options.maxFrameBytes }),
          onProven: (peer) => void proven.set(id, peer),
          // a refused peer is still published; without this its next report buys another path
          onRefused: () => backoff.failed(id),
          onClosed: (why) => {
            drop(why);
            closePath(id);
          },
        });
        held.set(id, { link, ...(claimed !== undefined && { claimed }) });
      };

      const link = async (id: string, claimed: string): Promise<void> => {
        opening.add(id);
        // the cheap refusal: a path this radio was never going to keep is not worth negotiating
        const announced = claimedPeer(claimed);
        if (announced !== undefined && !(await mayDial(announced))) {
          opening.delete(id);
          return;
        }
        const opened = await Result.tryPromise({
          try: () => fabric.connect(id),
          catch: (cause) => cause,
        });
        opening.delete(id);
        if (opened.isErr()) {
          condition = "connecting-failed";
          drop(`no path to ${claimed.slice(0, 8)}: ${String(opened.error)}`);
          backoff.failed(id);
          return;
        }
        backoff.succeeded(id);
        condition = "ok";
        hold(id, opened.value, claimed);
      };

      fabric.onPath((stream, from) => {
        // whoever opened it is a peer we have not named: the handshake names it, or nothing does
        if (!held.has(from)) hold(from, stream);
      });

      fabric.onPeerFound((peer) => {
        const claimed = claimedBy(peer);
        if (claimed === undefined) return; // running our service, but not speaking our protocol
        if (claimed === self) return; // ourselves, reported back by a platform that does that
        if (held.has(peer.id) || opening.has(peer.id)) return;
        if (!shouldDial(self, claimed)) return; // the other end opens the path; we accept it
        if (!backoff.ready(peer.id)) return;
        void link(peer.id, claimed);
      });

      // a peer the platform has stopped reporting is out of range, and its path is already dead
      fabric.onPeerLost((id) => {
        backoff.forget(id);
        closePath(id);
      });

      const published = await Result.tryPromise({
        try: () => fabric.publish(serviceName(options.id, protocol), announces(self)),
        catch: (cause) => cause,
      });
      if (published.isErr()) {
        condition = "discovery-failed";
        drop(`${adapter} could not publish its service: ${String(published.error)}`);
      }
    },
    close: async () => {
      for (const [, entry] of held) entry.link.close();
      held.clear();
      proven.clear(); // a stopped radio reaches nobody, whatever it proved while it was up
      const stopped = await Result.tryPromise({
        try: () => fabric.stop(),
        catch: (cause) => cause,
      });
      if (stopped.isErr()) drop(`the radio did not shut down cleanly: ${String(stopped.error)}`);
    },
  });

  return {
    ...transport,
    reaches: () => new Set(proven.values()),
    maxLinks: () => options.maxLinks ?? DEFAULT_MAX_LINKS,
    drop: (peer) => {
      for (const [id, found] of proven) if (found === peer) closePath(id);
    },
  };
};

/**
 * Apple Wireless Direct Link: Apple ↔ Apple, no access point (book ch. 16).
 *
 * The AirDrop link, and Apple's own — an Android phone never appears on it. This is the fast
 * path on Apple hardware that predates the Wi-Fi Aware framework; where both ends have that,
 * {@link wifiAware} reaches further.
 */
export const awdl = (options: P2pOptions): Transport => p2pTransport("awdl", "awdl", options);

/**
 * Wi-Fi Aware, the Wi-Fi Alliance's Neighbor Awareness Networking (book ch. 16).
 *
 * The cross-platform fast path: Android 8 and up, and iOS 26 and up. Two phones from different
 * makers link here and nowhere else above BLE, which is why a mixed room that declares only
 * {@link awdl} falls back to a radio it did not need to.
 */
export const wifiAware = (options: P2pOptions): Transport =>
  p2pTransport("wifi-aware", "wifiAware", options);

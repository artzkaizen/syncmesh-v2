import type { PeerId } from "@syncmesh/kernel";
import type { ByteStream, Transport, TransportCondition, Upgraded } from "@syncmesh/transport";

import { parsePeerId } from "@syncmesh/kernel";
import { Result, omitUndefined, panic } from "@syncmesh/result";
import {
  createBackoff,
  createFrameTransport,
  createLiveness,
  shouldDial,
} from "@syncmesh/transport";

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
  /**
   * How often a data path that has gone quiet is prodded, and at 2.5× that, given up on.
   *
   * The only thing on this medium that ever notices a radio switched off underneath it. The
   * platform reports peers appearing and peers leaving; what it does not report is its own
   * adapter taking every path with it, so a path nobody is measuring is one this device holds
   * until it restarts. Default is `DEFAULT_KEEPALIVE_MS`, which is 5s.
   */
  readonly keepaliveMs?: number;
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
  let stopWatching = (): void => undefined;
  /** Assigned by `open`, because what it drops and re-publishes belongs to that run. */
  let wake = (): void => undefined;

  const transport = createFrameTransport({
    name: options.name ?? adapter,
    kind: protocol,
    condition: () => condition,
    ...omitUndefined({ onDropped: options.onDropped }),
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

      /**
       * Publishes the service, which is also how this device is told who else is running it.
       *
       * Kept as one function because it is run more than once: a radio that was switched off took
       * the discovery session with it, and the platform reports peers to a session rather than to
       * a device. Nothing is re-reported to a subscriber that no longer exists, so the way back
       * from a radio that came up again is to ask for it again.
       */
      const publish = async (): Promise<void> => {
        const published = await Result.tryPromise({
          try: () => fabric.publish(serviceName(options.id, protocol), announces(self)),
          catch: (cause) => cause,
        });
        if (published.isErr()) {
          condition = "discovery-failed";
          drop(`${adapter} could not publish its service: ${String(published.error)}`);
          return;
        }
        condition = "ok";
      };

      /**
       * The deadline that ends a data path nobody closed.
       *
       * Switch this radio off and every path it was holding dies where it stands, with no path
       * close, no failed write and no peer-lost: the platform talks about peers and about
       * services, and says nothing about its own adapter taking the links with it. Silence is
       * therefore the only evidence there is — and a path this device prodded and heard nothing
       * back from is one to drop and open again rather than hold.
       */
      const alive = createLiveness<string>({
        ...omitUndefined({ everyMs: options.keepaliveMs }),
        // the far side answers cursors with a digest, always: a re-request is this protocol's
        // keepalive, and the one frame both ends already know how to handle
        probe: () => transport.resync?.(),
        dead: (id) => {
          drop(`the path to ${id} went quiet and was dropped`);
          backoff.forget(id);
          closePath(id);
          // and asked for again, because a peer is reported to a discovery session and this
          // device may be the one whose session went away
          void publish();
        },
      });
      stopWatching = alive.stop;

      closePath = (id) => {
        const entry = held.get(id);
        if (entry === undefined) return;
        held.delete(id);
        alive.forget(id);
        proven.delete(id);
        entry.link.close();
      };

      /**
       * Everything this radio holds is dropped and discovery starts again, because something
       * outside knows the medium moved (`Transport.wake`).
       *
       * Unconditional, and that is the point: a data path belongs to the radio that negotiated
       * it, so a radio that was off has none left however alive they look from here — and an
       * abandoned path is indistinguishable from a healthy idle one until a deadline says
       * otherwise. Waiting that deadline out is what this exists to skip.
       */
      wake = () => {
        // deleted from under the iterator by `closePath`, which a Map allows
        for (const id of held.keys()) {
          backoff.forget(id);
          closePath(id);
        }
        void publish();
      };

      /**
       * A data path handed to the upgrader, remembered by the platform's own handle.
       *
       * Boundaries, the handshake and the door are the upgrader's. What is left here is what is
       * actually this radio's: which paths exist, and who the service information claimed.
       */
      const hold = (id: string, stream: ByteStream, claimed?: string): void => {
        const announced = claimedPeer(claimed);
        // watched before it is upgraded, so the deadline is re-armed by anything that arrives —
        // including the peer's hello, which is the first evidence this path carries at all
        const link = upgrade.bytes(alive.watch(id, stream), {
          ...omitUndefined({ claimed: announced, maxFrameBytes: options.maxFrameBytes }),
          onProven: (peer) => void proven.set(id, peer),
          // a refused peer is still published; without this its next report buys another path
          onRefused: () => backoff.failed(id),
          onClosed: (why) => {
            drop(why);
            closePath(id);
          },
        });
        held.set(id, { link, ...omitUndefined({ claimed }) });
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

      await publish();
    },
    close: async () => {
      stopWatching();
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
    /** See `wake` in `open`: drop every path and publish the service again. */
    wake: () => wake(),
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

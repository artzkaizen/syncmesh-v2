import type { PeerId } from "@syncmesh/kernel";
import type { Transport, TransportCondition, Upgraded } from "@syncmesh/transport";

import { Result, omitUndefined, panic } from "@syncmesh/result";
import {
  createBackoff,
  createDiscovery,
  createFrameTransport,
  createLiveness,
  shouldDial,
} from "@syncmesh/transport";

import type { LanAddress, LanNetwork, LanStream } from "./network.js";

import { MAX_ROOM_BYTES, announcement, readAnnouncement } from "./advert.js";

/**
 * The fast offline room: every device on one access point, found by multicast and linked over
 * streams (book ch. 16).
 *
 * Both roles run at once, because a room needs both: this device announces so it can be found
 * and listens so it can find. Which end dials is decided by {@link shouldDial} and nothing else,
 * so exactly one of any pair connects and the other accepts.
 *
 * Everything above a link is the bridge's: grants, cursors, the gap rule, resync. This file owns
 * only what is true of a local network — who is on it, who dials, and where an arriving byte
 * belongs.
 *
 * Every link is encrypted, with no setting that says otherwise. An access point carries
 * everyone's packets past everyone's network card, and the café's is not the clinic's: what the
 * bridge is handed is always a `secureLink`, so a peer that will not do the handshake gets
 * nothing across.
 */

export interface LanOptions {
  /**
   * The room. One access point is not one mesh: two apps on the café's Wi-Fi are two rooms, and
   * a device that dialled across them would open a link the bridge refuses for its whole life.
   */
  readonly id: string;
  readonly network: LanNetwork;
  readonly name?: string;
  /** How often this device repeats its announcement. Default 2s: cheap, and a lost one costs a beat. */
  readonly announceEveryMs?: number;
  /** How long a peer stays known after its last announcement. Default is discovery's. */
  readonly ttlMs?: number;
  /**
   * How often a connection that has gone quiet is prodded, and at 2.5× that, given up on.
   *
   * The only thing on this medium that ever notices a socket the network abandoned: an access
   * point that goes away closes nothing and reports nothing, so a link nobody is measuring is a
   * link this device holds until it restarts. Default is `DEFAULT_KEEPALIVE_MS`, which is 5s.
   */
  readonly keepaliveMs?: number;
  readonly maxFrameBytes?: number;
  /** A packet or a frame that went nowhere, for a log a person reads on a device. */
  readonly onDropped?: (why: string) => void;
}

/**
 * What a link across one access point moves, near enough (RFC-0012 §2). Nominal, and that is the
 * point: the scorer needs the *ratio* to a radio rather than a measurement, and being three
 * orders of magnitude above BLE is the whole of what puts a snapshot here instead of there.
 */
export const LAN_BANDWIDTH_BPS = 20_000_000;

export const DEFAULT_ANNOUNCE_EVERY_MS = 2_000;

/** One peer's link, and what is known about who is on the far end of it. */
interface Held {
  readonly link: Upgraded;
  /**
   * Who the announcement said would be there, on a link this device dialled. A claim, not a
   * fact: it stops a second dial to the same peer, and never says a frame may be routed here.
   */
  readonly claimed?: PeerId | undefined;
}

export function lan(options: LanOptions): Transport {
  const { network, id: room } = options;
  // outside anything async: a room id that will not fit is a wiring mistake, and every
  // announcement this adapter ever sends would fail on it
  if (new TextEncoder().encode(room).length > MAX_ROOM_BYTES)
    panic(`the room id "${room}" does not fit in an announcement (${MAX_ROOM_BYTES} bytes)`);
  const held = new Map<number, Held>();
  /**
   * The peer on each link, and only once the handshake has proved it. Anyone on the access point
   * can announce any peer id, so claiming to reach a peer on the strength of one would be
   * routing a frame at a signature nobody checked (E28).
   */
  const proven = new Map<number, PeerId>();
  const drop = (why: string) => options.onDropped?.(why);
  let condition: TransportCondition = "ok";
  let nextLink = 0;
  let closeLink = (link: number): void => void link;
  let stopAnnouncing = (): void => undefined;
  let stopWatching = (): void => undefined;
  /** Assigned by `open`, because everything it drops and re-announces belongs to that run. */
  let wake = (): void => undefined;

  /** Whether a link to this peer already exists, proved or merely dialled. */
  const linkedTo = (peer: string): boolean => {
    for (const id of proven.values()) if (id === peer) return true;
    for (const entry of held.values()) if (entry.claimed === peer) return true;
    return false;
  };

  const transport = createFrameTransport({
    name: options.name ?? "lan",
    kind: "lan",
    condition: () => condition,
    ...omitUndefined({ onDropped: options.onDropped }),
    /**
     * Direct and wide: a device across the room with no server in the path. Not `costly` — the
     * Wi-Fi radio is already up for everything else the device is doing.
     */
    route: () => ({ direct: true, bandwidthBps: LAN_BANDWIDTH_BPS }),
    open: async (ctx, _attach, upgrade, mayDial) => {
      const self = ctx.identity.peerId;
      /**
       * A peer that will not accept a connection announces itself every couple of seconds, and
       * dialling each announcement spends this device on a link that is not going to open.
       */
      const backoff = createBackoff();
      /**
       * Peers this device is dialling right now.
       *
       * Announcements repeat — that is what makes a late arrival findable — so without this, the
       * next one arrives while the first `dial` is still awaiting and opens a second connection
       * to the same device. The far end accepts both and answers on one, and everything written
       * to the other is lost.
       */
      const dialing = new Set<PeerId>();
      const seen = createDiscovery<LanAddress>(
        options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs },
      );
      /** Who a link is to, as far as this device knows — a proof, a claim, or neither. */
      const nameOf = (link: number): string =>
        (proven.get(link) ?? held.get(link)?.claimed)?.slice(0, 8) ?? "an unnamed peer";
      /**
       * The deadline that ends a connection nobody closed.
       *
       * A switched-off access point, or this device's own interface going down, leaves every TCP
       * connection open as far as this process can tell: the kernel accepts what it is handed and
       * carries none of it, and no `close` arrives on either end. Silence is therefore the only
       * evidence there is, and a link this device prodded and heard nothing back from is one to
       * hang up on and re-dial rather than hold.
       */
      const alive = createLiveness<number>({
        ...omitUndefined({ everyMs: options.keepaliveMs }),
        // the far side answers cursors with a digest, always: a re-request is this protocol's
        // keepalive, and the one frame both ends already know how to handle
        probe: () => transport.resync?.(),
        dead: (link) => {
          drop(`the connection to ${nameOf(link)} went quiet and was hung up on`);
          closeLink(link);
        },
      });
      stopWatching = alive.stop;

      closeLink = (link) => {
        const entry = held.get(link);
        if (entry === undefined) return;
        held.delete(link);
        alive.forget(link);
        const peer = proven.get(link) ?? entry.claimed;
        proven.delete(link);
        // stop knowing the peer too: otherwise its next announcement reads as one already seen
        // and nothing re-dials, so the device is gone until the process restarts
        if (peer !== undefined) seen.forget(peer);
        entry.link.close();
      };

      /**
       * Everything this device holds is dropped and discovery starts again, because something
       * outside knows the network moved (`Transport.wake`).
       *
       * Unconditional, and that is the point: a connection is bound to the interface it was
       * opened on, so a network that changed under this device has orphaned every one of them —
       * and an orphaned socket is indistinguishable from a healthy idle one until a deadline
       * says otherwise. Waiting out that deadline is the ~37 seconds this exists to skip. The
       * backoff goes with them: a delay earned while the network was gone is not a delay a
       * network that just came back should serve.
       */
      wake = () => {
        // deleted from under the iterator by `closeLink`, which a Map allows
        for (const [link, entry] of held) {
          const peer = proven.get(link) ?? entry.claimed;
          if (peer !== undefined) backoff.forget(peer);
          closeLink(link);
        }
        say(); // found now, rather than one announcement from now
      };

      /**
       * A stream handed to the upgrader, and remembered by a number of our own.
       *
       * Everything between the bytes and the bridge — boundaries, the handshake, the door — is
       * the upgrader's. What is left here is what is actually LAN's: which streams exist, and
       * who the announcement claimed is on them.
       */
      const hold = (stream: LanStream, claimed?: PeerId): void => {
        const id = (nextLink += 1);
        // watched before it is upgraded, so the deadline is re-armed by anything that arrives —
        // including the peer's hello, which is the first evidence this connection carries at all
        const link = upgrade.bytes(alive.watch(id, stream), {
          ...omitUndefined({ claimed, maxFrameBytes: options.maxFrameBytes }),
          onProven: (peer) => void proven.set(id, peer),
          // a refused peer keeps announcing; without this its next beat buys another handshake
          onRefused: (peer) => backoff.failed(peer),
          onClosed: (why) => {
            drop(why);
            closeLink(id);
          },
        });
        held.set(id, { link, ...omitUndefined({ claimed }) });
      };

      const dial = async (peer: PeerId, address: LanAddress): Promise<void> => {
        dialing.add(peer);
        // the cheap refusal: a peer the door will not take is not worth a socket and a handshake
        if (!(await mayDial(peer))) {
          dialing.delete(peer);
          seen.forget(peer);
          return;
        }
        const opened = await Result.tryPromise({
          try: () => network.dial(address),
          catch: (cause) => cause,
        });
        dialing.delete(peer);
        if (opened.isErr()) {
          condition = "connecting-failed";
          drop(`could not dial ${peer.slice(0, 8)}: ${String(opened.error)}`);
          backoff.failed(peer);
          seen.forget(peer); // its next announcement is a fresh sighting; backoff decides if it dials
          return;
        }
        backoff.succeeded(peer);
        condition = "ok";
        hold(opened.value, peer);
      };

      network.onConnection((stream) => {
        // whoever dialled is a peer we have not named: the handshake names it, or nothing does
        hold(stream);
      });

      network.onAnnouncement((bytes, from) => {
        const heard = readAnnouncement(bytes);
        if (heard === undefined) return; // somebody else's protocol, on a group we share
        if (heard.room !== room) return; // another app on the same access point, not our mesh
        if (heard.peer === self) return; // our own announcement, reflected back by the group
        // the host is where the datagram came from, not what it claimed: one of the two is cheap to forge
        seen.sighted(heard.peer, { host: from.host, port: heard.port });
        if (linkedTo(heard.peer) || dialing.has(heard.peer)) return;
        if (!shouldDial(self, heard.peer)) return; // the other end dials; we accept when it does
        if (!backoff.ready(heard.peer)) return;
        void dial(heard.peer, { host: from.host, port: heard.port });
      });

      const say = (): void => {
        try {
          network.announce(announcement(self, room, network.address().port));
          condition = "ok";
        } catch (cause) {
          condition = "discovery-failed";
          drop(`the announcement did not leave: ${String(cause)}`);
        }
        // peers that went quiet and hold no link are forgotten, so a re-announcement is new again
        for (const gone of seen.lost(linkedTo)) backoff.forget(gone);
      };

      say(); // found now, rather than one interval from now
      const beat = setInterval(say, options.announceEveryMs ?? DEFAULT_ANNOUNCE_EVERY_MS);
      // a repeating announcement is not a reason for a process to stay alive
      beat.unref?.();
      stopAnnouncing = () => clearInterval(beat);
    },
    close: async () => {
      stopAnnouncing();
      stopWatching();
      for (const [, entry] of held) entry.link.close();
      held.clear();
      proven.clear(); // a closed network reaches nobody, whatever it proved while it was open
      const stopped = await Result.tryPromise({
        try: () => network.close(),
        catch: (cause) => cause,
      });
      if (stopped.isErr()) drop(`the network did not shut down cleanly: ${String(stopped.error)}`);
    },
  });

  return {
    ...transport,
    /**
     * The peers with an open session on this network (E28). Only those the handshake proved: a
     * link that has been dialled but has not finished its session is absent, which is correct —
     * it cannot carry a frame yet either.
     */
    reaches: () => new Set(proven.values()),
    /** See `wake` in `open`: drop every connection and start from an announcement. */
    wake: () => wake(),
    /**
     * No `maxLinks`. An access point is not a BLE controller: it does not degrade every link at
     * the seventh, and a number invented here would be a budget the medium never asked for.
     */
    drop: (peer) => {
      for (const [link, id] of proven) if (id === peer) closeLink(link);
      for (const [link, entry] of held) if (entry.claimed === peer) closeLink(link);
    },
  };
}

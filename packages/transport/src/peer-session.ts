import type { Unsubscribe } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";

import { createHub } from "@syncmesh/engine";

import type { Bridge } from "./bridge.js";
import type { FrameLink } from "./link.js";
import type { RouteCandidate, RouteProfile } from "./route-scorer.js";

import { classOf, KIND } from "./frame-parts.js";
import { ORDINARY_LINK, pickRoutes } from "./route-scorer.js";

/**
 * One session per peer, not one per link (book ch. 16).
 *
 * A phone in the same room as a laptop may reach it over BLE, over the access point and over
 * peer-to-peer Wi-Fi at the same moment. Three links used to mean three bridges: three sets of
 * cursors for one conversation, the same event sent three times, and three seats at a door that
 * was counting peers. One session means one conversation, carried by whichever link suits the
 * frame in hand.
 *
 * **Mid-transfer resume falls out of this rather than being built.** Progress is cursor state,
 * and the cursors belong to the session — so a link that dies during a snapshot is a link, not a
 * transfer: the next frame goes down another one and the exchange continues from where it was.
 *
 * Nothing here orders frames or dedupes them, because the bridge already does both: the gap rule
 * holds an event that arrived early and inbound dedup drops one that arrived twice. Two links
 * interleaving is the same problem as one link reordering, which was always solved.
 */

/** One live link to the peer, and what its medium says about itself. */
export interface SessionLink {
  /** The transport's name — the tie-break when two links score the same, so a run is repeatable. */
  readonly id: string;
  readonly link: FrameLink;
  /** Read per frame rather than captured: a radio renegotiates its bandwidth and a dormant one wakes. */
  readonly route?: () => RouteProfile;
}

export interface PeerSession {
  readonly peer: PeerId;
  /** The one bridge for this peer, whichever link its frames go down. */
  readonly bridge: Bridge;
  /** The transports currently carrying this peer, for `$status` and for a person reading a log. */
  readonly carriers: () => readonly string[];
  readonly close: () => void;
}

export interface PeerSessions {
  /**
   * Adds a proven link to this peer's session, building the session on the first one. `build`
   * makes the bridge over the multiplexed link, and is only called once per peer — whichever
   * transport gets there first supplies it, and they all supply the same thing.
   *
   * Returns the leave: a link that ends calls it, and the session closes with the last one.
   */
  readonly join: (
    peer: PeerId,
    member: SessionLink,
    build: (link: FrameLink) => Bridge,
  ) => Unsubscribe;
  readonly get: (peer: PeerId) => PeerSession | undefined;
  readonly peers: () => readonly PeerId[];
  /** Everything every session has taken in is folded. */
  readonly flush: () => Promise<void>;
  readonly closeAll: () => void;
}

/** What the scorer needs to know about one member, assembled per frame. */
const candidateFor = (member: SessionLink, peer: PeerId): RouteCandidate => ({
  id: member.id,
  online: true, // a member is only here while its link is live; leaving removes it
  ...(member.route?.() ?? ORDINARY_LINK),
  reaches: new Set([peer]),
});

/** One peer's session, its live links, and the hub they all feed. */
interface Held {
  readonly session: PeerSession;
  readonly members: Map<SessionLink, Unsubscribe>;
  readonly frames: ReturnType<typeof createHub<Uint8Array>>;
}

export function createPeerSessions(): PeerSessions {
  const sessions = new Map<PeerId, Held>();

  const open = (peer: PeerId, build: (link: FrameLink) => Bridge): Held => {
    const members = new Map<SessionLink, Unsubscribe>();
    const frames = createHub<Uint8Array>();

    /**
     * The link this frame goes down, chosen for this frame.
     *
     * The class is read off the wire rather than decoded, which is what keeps presence off a
     * sleeping radio and a snapshot page off a slow one without this file knowing what either
     * is. A frame whose class we cannot read is scored as an event: the ordinary case, and the
     * one that is never refused.
     */
    const mux: FrameLink = {
      send: (frame) => {
        const live = [...members.keys()];
        if (live.length === 0)
          throw new Error(`no link to ${peer.slice(0, 8)} — the frame did not leave`);
        const message = {
          cls: classOf(frame) ?? KIND.event,
          bytes: frame.length,
          to: peer,
        };
        const best = pickRoutes(
          live.map((member) => candidateFor(member, peer)),
          message,
        );
        const order = best
          .map((candidate) => live.find((member) => member.id === candidate.id))
          .filter((member): member is SessionLink => member !== undefined);
        // every link, in the scorer's order, before giving up: a frame nobody sends is
        // divergence, and a link that threw is one this session is about to lose anyway
        let failure: unknown;
        for (const member of [...order, ...live.filter((m) => !order.includes(m))]) {
          try {
            member.link.send(frame);
            return;
          } catch (cause) {
            failure = cause;
          }
        }
        throw failure ?? new Error(`no link to ${peer.slice(0, 8)} would carry the frame`);
      },
      onFrame: (cb) => frames.subscribe(cb),
      close: () => {
        for (const member of members.keys()) member.link.close?.();
      },
    };

    const bridge = build(mux);
    const session: PeerSession = {
      peer,
      bridge,
      carriers: () => [...members.keys()].map((member) => member.id),
      close: () => {
        for (const off of members.values()) off();
        members.clear();
        bridge.close();
        sessions.delete(peer);
      },
    };
    const held = { session, members, frames } satisfies Held;
    sessions.set(peer, held);
    return held;
  };

  return {
    join: (peer, member, build) => {
      const held = sessions.get(peer) ?? open(peer, build);
      // one hub for every link: which one a frame arrived on is not a fact the bridge needs
      const off = member.link.onFrame((frame) => held.frames.emit(frame));
      held.members.set(member, off);
      return () => {
        const leaving = held.members.get(member);
        if (leaving === undefined) return;
        leaving();
        held.members.delete(member);
        // the last link out ends the conversation; the next one rebuilds it from the cursors,
        // which is the same recovery a single link's reconnect has always used
        if (held.members.size === 0) held.session.close();
      };
    },
    get: (peer) => sessions.get(peer)?.session,
    peers: () => [...sessions.keys()],
    flush: async () => {
      await Promise.all([...sessions.values()].map((held) => held.session.bridge.flush()));
    },
    closeAll: () => {
      // deleting the current entry while iterating a Map is defined, and `close` does exactly that
      for (const held of sessions.values()) held.session.close();
    },
  };
}

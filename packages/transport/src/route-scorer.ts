import type { FrameClass } from "./frame-parts.js";

import { KIND } from "./frame-parts.js";

/**
 * Which of the open links carries this frame — pure, deterministic, no clock and no state, so
 * two devices holding the same candidates make the same choice and a routing decision can be
 * reproduced in a test rather than guessed at from a log.
 *
 * **Nothing calls this, on purpose.** With one transport there is nothing to choose, and today
 * every device has one: the mesh sends on every link. The caller is the send path of the mesh
 * manager (RFC-0012 §2), and it arrives with the second radio, which is also the
 * first moment a test can prove a bulk payload left the narrow pipe. Wiring it earlier would put
 * the untested half of the change in the send path, where a mistake costs convergence.
 */

/** Bits in a byte — the one conversion between a payload size and a link's declared rate. */
const BITS_PER_BYTE = 8;

/** Every online link starts here; penalties come off, the direct bonus goes on. */
const BASE = 1000;

/** A mesh should not touch the cloud when a peer is two metres away. */
const DIRECT = 200;

/**
 * Occupancy, per second of it: 2 MB over a 24 kbps radio is eleven minutes of blocked mesh.
 * Priced above `DIRECT` per second, so a couple of seconds of the medium's time outweighs the
 * hop a direct link saves — which is the whole of "large payloads avoid narrow pipes".
 */
const PER_SECOND = 100;

/** An expensive radio's power spent on a frame too small to have needed it. */
const COSTLY_SMALL = 700;

/** The same trade with someone waiting on it: still worse than any cheap open link, not fatal. */
const COSTLY_SMALL_URGENT = 300;

/** Heavy enough that any open link outranks a sleeping radio, light enough to stay routable. */
const DORMANT = 800;

/**
 * Below this a payload has not earned an expensive radio's power — nor the wake that brings one
 * up (RFC-0012 §2). One threshold, because it is one question: is there enough here to pay for it.
 */
const WORTH_THE_POWER = 8_192;

/** An offline candidate scores this and is filtered out; nothing else ever reaches it. */
const UNROUTABLE = 0;

/** The worst an online link scores. A penalised link is still a link — see `pickRoutes`. */
const ROUTABLE_FLOOR = 1;

/**
 * What a medium says about itself: plain data on the adapter, never a channel type
 * (RFC-0005, "forbidden leaks"). An absent flag is the ordinary case, not an unknown.
 */
export interface RouteCandidate {
  /** The transport's name, which is also the tie-break — see `pickRoutes`. */
  readonly id: string;
  /** Being offline is the only fact that makes a candidate unroutable; the rest are penalties. */
  readonly online: boolean;
  /** A link to the peer itself rather than a path through a server. */
  readonly direct: boolean;
  readonly bandwidthBps: number;
  /** Costs power out of proportion to the bytes it moves — an expensive radio, not a slow one. */
  readonly costly?: boolean;
  /** The radio is down. Small traffic must not be what wakes it. */
  readonly dormant?: boolean;
}

/** The frame to place: its class, its size, and how many links it is worth putting it on. */
export interface RouteMessage {
  /**
   * The wire tag, which is also the traffic class the outbox orders by — one tag space for
   * "who goes first" and "who carries it", so the two can never drift apart.
   */
  readonly cls: FrameClass;
  readonly bytes: number;
  /** Send it down this many links, best first — a frame worth sending twice. Default 1. */
  readonly redundancy?: number;
}

/**
 * Urgency is a threshold on the tag order rather than a second table of its own: everything up
 * to and including an event is someone waiting, and everything after it (presence, a digest, a
 * snapshot page) can afford the cheap path.
 */
const isUrgent = (cls: FrameClass): boolean => cls <= KIND.event;

/** What a costly link costs a frame that did not need it; less where someone is waiting on it. */
const energyOf = (cls: FrameClass): number => (isUrgent(cls) ? COSTLY_SMALL_URGENT : COSTLY_SMALL);

/** Lexicographic on the id, so the order candidates were discovered in cannot decide a route. */
const byId = (x: RouteCandidate, y: RouteCandidate): number =>
  x.id < y.id ? -1 : x.id > y.id ? 1 : 0;

/**
 * How well one link suits one frame. Higher is better; `0` means it cannot carry it at all.
 *
 * The bias, in order: an offline candidate is never picked; a direct link beats a relayed one;
 * an expensive path is penalised heavily for a payload too small to have justified its power,
 * less so when someone is waiting on the frame; and every payload pays for the seconds it will
 * occupy the medium, which is what keeps a 2 MB snapshot off a 24 kbps radio and a 14 KB page
 * on the wide link, without anyone having to name BLE anywhere in this file.
 *
 * Only presence is ever refused outright: waking a sleeping radio for a value the next one
 * replaces is the trade RFC-0012 says never to make. Every other class keeps a floor score, so
 * a device whose only path is a bad one still sends — a route this function declined to pick is
 * a frame nobody sends, and that is divergence, not routing.
 */
export function scoreRoute(candidate: RouteCandidate, message: RouteMessage): number {
  if (!candidate.online) return UNROUTABLE;
  const worth = message.bytes >= WORTH_THE_POWER;
  const waking = candidate.dormant === true && !worth;
  if (waking && message.cls === KIND.presence) return UNROUTABLE;
  const seconds = (message.bytes * BITS_PER_BYTE) / Math.max(candidate.bandwidthBps, 1);
  const energy = candidate.costly === true && !worth ? energyOf(message.cls) : 0;
  const score = BASE + (candidate.direct ? DIRECT : 0) - seconds * PER_SECOND - energy;
  return Math.max(score - (waking ? DORMANT : 0), ROUTABLE_FLOOR);
}

/**
 * The links to send this frame on, best first — one of them, or `redundancy` of them where the
 * frame is worth the duplicate (arriving twice is a no-op: inbound dedup already holds).
 *
 * Equal scores break on the candidate id rather than on the order the candidates were
 * discovered in, so the same facts give the same answer on every device and in every run.
 */
export function pickRoutes(
  candidates: readonly RouteCandidate[],
  message: RouteMessage,
): readonly RouteCandidate[] {
  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreRoute(candidate, message) }))
    .filter((entry) => entry.score > UNROUTABLE)
    .sort((x, y) => y.score - x.score || byId(x.candidate, y.candidate));
  return scored.slice(0, Math.max(message.redundancy ?? 1, 1)).map((entry) => entry.candidate);
}

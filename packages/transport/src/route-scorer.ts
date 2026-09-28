import type { PeerId } from "@syncmesh/kernel";

import type { FrameClass } from "./frame-parts.js";

import { KIND } from "./frame-parts.js";

/**
 * Which of the open links carries this frame — pure, deterministic, no clock and no state, so
 * two devices holding the same candidates make the same choice and a routing decision can be
 * reproduced in a test rather than guessed at from a log.
 *
 * **The mesh uses this as a filter and an order, not as a chooser** (`runTransports.route`).
 * Which single link reaches a given peer is a different question, and the component that can
 * answer it — link admission, RFC-0012 §1 — does not exist yet: a transport publishes no
 * per-peer link list, so narrowing a broadcast to the winner here would silently stop talking
 * to a peer whose only path was the link that lost. What the scoring does decide today is real
 * enough: an offline link is never tried, and a dormant expensive radio is never woken by
 * presence.
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

/** Where the ordinary scale bottoms out. A penalised link is still a link — see `pickRoutes`. */
const ROUTABLE_FLOOR = 1;

/**
 * Keeps every online link routable without flattening the order among the badly penalised ones.
 *
 * Clamping to a constant made every link past the floor score exactly the same. A 2 MB snapshot
 * scored `1` on a 24 kbps radio and `1` on the relay, so the tie broke on the transport's *name*
 * — and `"ble"` sorts before `"relay"`, which put eleven minutes of blocked radio ahead of a
 * second and a half on the wide link, the exact trade this scorer exists to prevent.
 *
 * Below the floor the score compresses into `(0, ROUTABLE_FLOOR]` instead. Continuous at the
 * floor, monotone all the way down, and never zero — so the ordering the penalties established
 * survives, and `UNROUTABLE` still means offline and nothing else.
 */
const routable = (score: number): number =>
  score >= ROUTABLE_FLOOR ? score : ROUTABLE_FLOOR / (1 + ROUTABLE_FLOOR - score);

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
  /**
   * The peers this link currently reaches (E28). Absent means the medium cannot say, which is
   * not the same as reaching nobody — see {@link pickRoutes}.
   */
  readonly reaches?: ReadonlySet<PeerId>;
}

/**
 * A medium describing itself. The mesh supplies the two facts a medium does not own: the `id`,
 * which is the transport's name, and whether it is `online`, which comes from `onStatus` so that
 * one fact has one owner.
 */
export type RouteProfile = Omit<RouteCandidate, "id" | "online">;

/**
 * A medium that says nothing about itself: a path through a server, of unremarkable bandwidth
 * and no power cost worth pricing. This is the relay, which is why the relay declares nothing —
 * it is the floor RFC-0012 §2 describes, always a candidate and never the reason a frame did
 * not go.
 */
export const ORDINARY_LINK = { direct: false, bandwidthBps: 1_000_000 } satisfies RouteProfile;

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
  /**
   * The peer this frame is for, where there is one. Absent is a broadcast — presence and a grant
   * request are addressed to nobody in particular, and go wherever they can.
   */
  readonly to?: PeerId;
}

/**
 * How an embedder orders the mediums that could carry a frame.
 *
 * **It orders; it never excludes.** Returning a low number moves a medium down the list, and a
 * medium at the bottom of the list is still asked when nothing above it claimed the addressee.
 * Reachability — who claimed the peer, who denied it, who said nothing — stays this file's, because
 * those are the rules that decide whether a frame is delivered at all, and a policy that could
 * suppress a medium could lose a write. An app tunes preference; the library keeps the guarantee.
 *
 * The facts it is handed are the ones a medium can honestly state about itself. Deliberately absent
 * are signal strength and distance: neither is plumbed through any radio port here, and a field a
 * policy could read but nobody could populate is worse than no field — the first person to write a
 * transport would trust it.
 *
 * @example
 * // a fleet whose phones are charging in a rack: prefer the wide link, spend no radio
 * const policy: RoutePolicy = (candidate, message) =>
 *   candidate.direct ? scoreRoute(candidate, message) - 500 : scoreRoute(candidate, message);
 */
export type RoutePolicy = (candidate: RouteCandidate, message: RouteMessage) => number;

/**
 * Urgency is a threshold on the tag order rather than a second table of its own: everything up
 * to and including an event is someone waiting, and everything after it (presence, a digest, a
 * snapshot page) can afford the cheap path.
 */
const isUrgent = (cls: FrameClass): boolean => cls <= KIND.event;

/** What a costly link costs a frame that did not need it; less where someone is waiting on it. */
const energyOf = (cls: FrameClass): number => (isUrgent(cls) ? COSTLY_SMALL_URGENT : COSTLY_SMALL);

/**
 * The candidates that claim this peer, or **all of them** when none does.
 *
 * Narrowing is an optimisation and never a refusal. A medium that cannot enumerate its links
 * says nothing, and a peer no link claims may still be reachable down one that simply does not
 * track it — so an empty claim set falls back to the broadcast this was before. A route narrowed
 * to nothing is a frame nobody sends, and that is divergence rather than routing.
 *
 * **A medium has three answers about a peer, and the first version of this read two.** It can
 * claim the peer, it can *deny* it — enumerate its links and not list it — or it can say nothing,
 * because it does not track links at all. Only the denial is an answer. Treating a claim as
 * exclusive let one medium silence every other: a `proven` entry outlives its link by up to the
 * liveness deadline, and for that whole window the claiming radio was the only medium asked, so
 * an event handed to a dead link was simply lost. The relay could have carried it and was never
 * offered it, because it cannot enumerate a room and therefore never claims anybody.
 *
 * So: a denial excludes, and nothing else does. A shrug is asked alongside a claim, which costs
 * the duplicate that inbound dedup already absorbs and buys the path that actually delivers.
 */

/** Whether this medium positively claims the addressee — evidence, as against a shrug. */
const claims = (candidate: RouteCandidate, to: PeerId | undefined): boolean =>
  to !== undefined && candidate.reaches?.has(to) === true;

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
  return routable(score - (waking ? DORMANT : 0));
}

/**
 * One medium's place in the order, with the two things a policy is not allowed to decide.
 *
 * An offline medium is unroutable whatever a policy says — that is a fact, not a preference. And a
 * policy that returns something unusable (a `NaN` from a division nobody guarded, an `Infinity`
 * from a reciprocal) must not be able to reorder the whole list or, worse, sink a medium below the
 * threshold that means "cannot carry this": a routing preference that silently drops writes is the
 * failure mode this seam exists to make impossible. Anything unusable falls back to the built-in
 * score, so a broken policy costs its preference and never a frame.
 */
const ranked = (candidate: RouteCandidate, message: RouteMessage, policy: RoutePolicy): number => {
  // the library's own refusals run first and are not a policy's to overturn: a medium that is
  // offline cannot carry anything, and presence must never be the traffic that wakes a radio
  const own = scoreRoute(candidate, message);
  if (own <= UNROUTABLE) return UNROUTABLE;
  if (policy === scoreRoute) return own;
  const said = policy(candidate, message);
  // `routable` rather than a clamp: it compresses into `(0, ROUTABLE_FLOOR]` instead of flattening,
  // so a heavily penalised medium keeps its place in the order rather than tying with every other
  // penalised one and breaking on the transport's *name* — the bug that put a 2 MB snapshot on a
  // 24 kbps radio because `"ble"` sorts before `"relay"`
  return Number.isFinite(said) ? routable(said) : own;
};

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
  policy: RoutePolicy = scoreRoute,
): readonly RouteCandidate[] {
  const { to } = message;
  /**
   * A medium has three answers about a peer, and the first version of this read two.
   *
   * It can claim the peer, it can *deny* it — enumerate its links and not list it — or it can say
   * nothing, because it does not track links at all. Only a denial is an answer, and only a denial
   * excludes. Reading a shrug as a refusal is what let the relay be narrowed away: it cannot
   * enumerate a room, so it never claims anybody, so it was never asked.
   */
  const notDenying =
    to === undefined
      ? candidates
      : candidates.filter(
          (candidate) => candidate.reaches === undefined || candidate.reaches.has(to),
        );
  /** Every medium that tracks its links denied this peer: nothing here holds it. */
  const everyoneDenied = to !== undefined && notDenying.length === 0;
  // a frame nobody sends is divergence rather than routing, so a total denial still offers it
  const asked = everyoneDenied ? candidates : notDenying;
  const claimed = asked.some((candidate) => claims(candidate, to));

  const scored = asked
    .map((candidate) => ({
      candidate,
      claimed: claims(candidate, to),
      score: ranked(candidate, message, policy),
    }))
    .filter((entry) => entry.score > UNROUTABLE)
    /**
     * A claim outranks a shrug before any score is compared.
     *
     * Scoring answers "which medium suits this frame", which is the right question only between
     * mediums that have each said they hold the addressee. Letting `direct` and bandwidth lift a
     * medium that said *nothing* above one that claimed the peer is how a small event goes to the
     * radio with the shortest reach instead of the relay that was holding them.
     */
    .sort(
      (x, y) =>
        Number(y.claimed) - Number(x.claimed) ||
        y.score - x.score ||
        byId(x.candidate, y.candidate),
    );

  /**
   * Capping to the best few is only honest when somebody claimed the addressee.
   *
   * With a claim, the ranking is between mediums that have each said they hold this peer, and
   * taking the best of them is the decision this function exists to make. With nothing but
   * shrugs, there is no evidence to rank on — so every medium is asked, and the duplicate that
   * costs is the one inbound dedup already absorbs. A total denial caps too: offering a frame to
   * mediums that have all said they cannot reach the peer spends every one of them to no end.
   */
  const capped = to === undefined || claimed || everyoneDenied;
  const picked = capped ? scored.slice(0, Math.max(message.redundancy ?? 1, 1)) : scored;
  return picked.map((entry) => entry.candidate);
}

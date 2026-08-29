import type { PeerId } from "@syncmesh/kernel";

/**
 * Which peers to keep a link to when a radio cannot hold them all (RFC-0012 §1, E28).
 *
 * Pure and deterministic given its inputs, like {@link scoreRoute} — but unlike route selection,
 * this needs **no** cross-device agreement. Two phones may keep different neighbours and the mesh
 * is still connected; what matters is that each device's own answer is reproducible in a test
 * rather than guessed at from a log.
 */

/** One discovered peer, as the facts a manager can know about it locally. */
export interface Neighbour {
  readonly peer: PeerId;
  /** Events this peer holds that we lack. The reason to keep a link at all. */
  readonly behind: number;
  /** How many of our partitions it shares. A peer holding none of them can tell us nothing. */
  readonly shared: number;
  /** Link quality — RSSI or a throughput average, normalised to `0..1`. */
  readonly quality: number;
  /** A session is already open. What hysteresis protects. */
  readonly live?: boolean;
}

/**
 * Coverage first, and by a wide margin: a link exists to carry events this device lacks, and a
 * strong signal to a peer with nothing to say is a slot spent on nothing. Overlap is next
 * because a peer sharing no partition cannot become useful later. Quality only breaks ties.
 */
const FRESHNESS = 1000;
const OVERLAP = 300;
const QUALITY = 100;

/** Past this, more is not more: a peer a thousand events behind is as worth dialling as one ten. */
const FRESHNESS_CAP = 64;
/** Likewise for partitions — sharing six is not six times sharing one. */
const OVERLAP_CAP = 8;

/**
 * What a challenger must beat a live session by. Churn costs a handshake, a catch-up and the
 * frames in flight, so a neighbour that is merely *slightly* better is not worth the exchange.
 */
const HYSTERESIS = 250;

const saturate = (value: number, cap: number): number => Math.min(Math.max(value, 0), cap) / cap;

/** How much this device wants a link to this peer. Higher is better. */
export function scoreNeighbour(neighbour: Neighbour): number {
  const freshness = FRESHNESS * saturate(neighbour.behind, FRESHNESS_CAP);
  const overlap = OVERLAP * saturate(neighbour.shared, OVERLAP_CAP);
  const quality = QUALITY * saturate(neighbour.quality, 1);
  return freshness + overlap + quality + (neighbour.live === true ? HYSTERESIS : 0);
}

export interface AdmissionOptions {
  /** What the radio sustains, declared by the medium — never by the app. See {@link admit}. */
  readonly maxLinks: number;
  /**
   * Picks the peer that takes the reserved slot from those greedy scoring would have cut.
   * Injected so a test is deterministic; a device passes nothing and gets a random one.
   */
  readonly rotate?: (among: readonly Neighbour[]) => Neighbour | undefined;
}

const randomly = (among: readonly Neighbour[]): Neighbour | undefined =>
  among[Math.floor(Math.random() * among.length)];

/** Lexicographic on the peer id, so discovery order cannot decide who is kept. */
const byPeer = (x: Neighbour, y: Neighbour): number =>
  x.peer < y.peer ? -1 : x.peer > y.peer ? 1 : 0;

/**
 * The peers to hold links to, best first, at most `maxLinks` of them.
 *
 * **One slot is kept for rotation, and that is not a nicety.** Pure greedy coverage scoring makes
 * every device keep the same well-connected neighbours, which settles the graph into cliques —
 * and a clique is a partition that looks like a working mesh, because every device inside it is
 * synced and nobody is watching the edge that no longer exists. The reserved slot is what keeps
 * an unlikely link alive long enough to be the one that matters.
 *
 * The slot is spent only when it costs something: with room to spare every neighbour is kept, so
 * rotation is what happens under pressure and not a link permanently withheld.
 *
 * @example
 * const keep = admit(discovered, { maxLinks: 6 });
 */
export function admit(
  neighbours: readonly Neighbour[],
  options: AdmissionOptions,
): readonly PeerId[] {
  const budget = Math.max(options.maxLinks, 0);
  if (budget === 0) return [];
  if (neighbours.length <= budget) return [...neighbours].map((n) => n.peer);

  const ranked = [...neighbours].sort(
    (x, y) => scoreNeighbour(y) - scoreNeighbour(x) || byPeer(x, y),
  );
  // the last slot is rotation's, unless there is only one to give — a single-link radio spends
  // it on the best peer it found, because a rotation that is the whole mesh is not a mesh
  const greedy = budget === 1 ? 1 : budget - 1;
  const kept = ranked.slice(0, greedy);
  const cut = ranked.slice(greedy);
  const wildcard = greedy === budget ? undefined : (options.rotate ?? randomly)(cut);
  return [...kept, ...(wildcard === undefined ? [] : [wildcard])].map((n) => n.peer);
}

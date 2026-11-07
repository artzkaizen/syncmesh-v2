import type { Ack } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { LinkEvent, Transport, TransportContext } from "@syncmesh/transport";

import { Temporal, durationMs } from "@syncmesh/temporal";

/**
 * Stale-link detection (RFC-0012 §1, E28's last missing state): a link that is up and has gone
 * quiet is told apart from one that is working, and its slot reclaimed.
 *
 * A session that stops carrying anything looks, from here, exactly like a session with nothing
 * to say — until something is asked of it. On a radio that is a slot spent on a peer that may
 * have walked out of range with the link never closing; on a socket it is a half-open
 * connection the far side abandoned. Before this, only the budget sweep or an outright failure
 * ever reclaimed either.
 *
 * What "heard" means is the engine's own fact: a peer that acknowledged anything — every cursor
 * exchange does — was heard then ({@link Ack.at}). A peer that has never acknowledged is dated
 * from when this watch first saw it on the link, so a fresh session is given the full window
 * before it can be called quiet. Dropping is a slot reclaimed, not a refusal: the peer stays
 * discoverable, and its next advertisement may re-dial it.
 *
 * Opt-in, because the right window is the medium's and the app's to say: a relay socket
 * already has a keepalive deadline, and a radio that is meant to sit silent for an hour must
 * not be dropped for doing so.
 */

export interface StaleOptions {
  /** How long a peer may say nothing before its link is stale. */
  readonly after: Temporal.Duration;
  /** How often to look. Default half of `after`, and never under a second. */
  readonly everyMs?: number;
  /** A link reclaimed, for a log a person reads on a device. */
  readonly onStale?: (peer: PeerId, transport: string) => void;
}

/** What the watch reads: when each peer last acknowledged anything, and the clock it judges by. */
export interface StaleFacts {
  readonly acksAt: () => ReadonlyMap<PeerId, Ack>;
  readonly now: () => Temporal.Instant;
}

export interface StaleWatch {
  /** Looks at every transport now, as the timer would. Returns what it dropped. */
  readonly now: () => readonly PeerId[];
  readonly stop: () => void;
}

/** A medium this applies to: it names its links and can close one. */
const watchable = (transport: Transport): boolean =>
  transport.reaches !== undefined && transport.drop !== undefined;

export function createStaleWatch(
  transports: () => readonly Transport[],
  facts: () => StaleFacts,
  options: StaleOptions,
): StaleWatch {
  const window = durationMs(options.after);
  /** When each peer was first seen on each medium, so a fresh link is given the whole window. */
  const seen = new Map<string, Map<PeerId, Temporal.Instant>>();

  /** When this peer was last known to be there: its latest acknowledgement, or its first sight. */
  const lastHeard = (
    acks: ReadonlyMap<PeerId, Ack>,
    peer: PeerId,
    opened: Temporal.Instant,
  ): Temporal.Instant => {
    const heard = acks.get(peer)?.at;
    return heard !== undefined && Temporal.Instant.compare(heard, opened) > 0 ? heard : opened;
  };

  /** One medium's links, judged: the peers dropped for silence. */
  const sweep = (transport: Transport, acks: ReadonlyMap<PeerId, Ack>, at: Temporal.Instant) => {
    const reached = transport.reaches?.() ?? new Set<PeerId>();
    const first = seen.get(transport.name) ?? new Map<PeerId, Temporal.Instant>();
    seen.set(transport.name, first);
    // a peer no longer on the link is forgotten, so a return later starts a fresh window
    for (const peer of first.keys()) if (!reached.has(peer)) first.delete(peer);
    const dropped: PeerId[] = [];
    for (const peer of reached) {
      const opened = first.get(peer);
      if (opened === undefined) {
        first.set(peer, at);
        continue;
      }
      if (lastHeard(acks, peer, opened).until(at).total({ unit: "milliseconds" }) < window)
        continue;
      transport.drop?.(peer);
      first.delete(peer);
      options.onStale?.(peer, transport.name);
      dropped.push(peer);
    }
    return dropped;
  };

  const round = (): readonly PeerId[] => {
    const { acksAt, now } = facts();
    const at = now();
    const acks = acksAt();
    return transports()
      .filter(watchable)
      .flatMap((transport) => sweep(transport, acks, at));
  };

  const timer = setInterval(round, options.everyMs ?? Math.max(1000, Math.floor(window / 2)));
  // a watch is not a reason for a process to stay alive
  timer.unref?.();

  return { now: round, stop: () => clearInterval(timer) };
}

/**
 * The watch as a mesh runs it: the engine's acknowledgements and clock as its facts, and every
 * link it reclaims said on the link feed as a close with its reason — the one ending nothing
 * else would ever say out loud.
 */
export function watchStaleLinks(
  transports: () => readonly Transport[],
  context: TransportContext,
  report: (event: LinkEvent) => void,
  options: StaleOptions,
): StaleWatch {
  const now = (): Temporal.Instant => context.now?.() ?? Temporal.Now.instant();
  return createStaleWatch(transports, () => ({ acksAt: () => context.engine.acksAt(), now }), {
    ...options,
    onStale: (peer, transport) => {
      report({
        kind: "closed",
        transport,
        peer,
        why: "stale: nothing heard from this peer within the window",
        at: now(),
      });
      options.onStale?.(peer, transport);
    },
  });
}

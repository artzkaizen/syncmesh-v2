/**
 * Which of two devices opens the connection.
 *
 * Both ends see each other's advertisement at roughly the same moment, and both would otherwise
 * dial. The lexicographically smaller peer id dials and the other waits — one rule, evaluated
 * identically on both devices from facts they already share, so it needs no negotiation and
 * cannot deadlock.
 *
 * This is the one part of the previous implementation that was genuinely proven, and it is worth
 * saying why it is not merely tidy: without it both ends hold a half-open handshake, each waiting
 * for the other to answer on a connection the other never made.
 *
 * Takes whatever string both ends can compare. Before a connection exists that is the
 * advertisement hint, which is all either device has; the order is the same either way.
 */
export const shouldDial = (self: string, other: string): boolean => self < other;

/**
 * A peer heard from, and when. Advertisements repeat several times a second on some platforms,
 * so a device is "found" once and only forgotten after it has genuinely gone quiet.
 */
export interface Sighting {
  /** The advertisement hint — not an identity, and not to be treated as one. */
  readonly hint: string;
  /** What the radio calls the device, which is neither the hint nor stable across platforms. */
  readonly peripheralId: string;
  seenAt: number;
}

export interface DiscoveryOptions {
  /** How long a peer stays known after its last advertisement. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_TTL_MS = 15_000;

/**
 * Who is nearby, from a stream of advertisements that repeat.
 *
 * `found` fires once per peer rather than once per advertisement, because a scan with duplicates
 * enabled reports the same device continuously and a transport that attached on every one would
 * rebuild the link several times a second.
 *
 * **A connected peer is not forgotten for going quiet.** Two iOS devices that are already
 * connected stop surfacing each other's advertisements entirely, so a TTL alone would drop a peer
 * precisely while it was working — `keep` is how the transport says a link is live.
 */
export function discovery(options: DiscoveryOptions = {}) {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const clock = options.now ?? (() => Date.now());
  const seen = new Map<string, Sighting>();

  return {
    /** `true` when this is the first sighting, which is when a caller should attach. */
    sighted: (hint: string, peripheralId: string): boolean => {
      const held = seen.get(hint);
      if (held !== undefined) {
        held.seenAt = clock();
        return false;
      }
      seen.set(hint, { hint, peripheralId, seenAt: clock() });
      return true;
    },
    /** The peripheral id last advertised under a hint — what `connect` takes, and it can change. */
    peripheralFor: (hint: string): string | undefined => seen.get(hint)?.peripheralId,
    /** Hints not heard from inside the window, minus the ones `keep` says are live. */
    lost: (keep: (hint: string) => boolean): readonly string[] => {
      const now = clock();
      const gone: string[] = [];
      for (const [hint, sighting] of seen) {
        if (now - sighting.seenAt <= ttl) continue;
        if (keep(hint)) {
          // connected and silent is the normal state of a paired iOS device, not a departure
          sighting.seenAt = now;
          continue;
        }
        seen.delete(hint);
        gone.push(hint);
      }
      return gone;
    },
    forget: (hint: string): void => void seen.delete(hint),
    known: (): number => seen.size,
  };
}

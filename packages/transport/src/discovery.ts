/**
 * Which of two devices opens the connection.
 *
 * Both ends see each other at roughly the same moment, and both would otherwise dial. The
 * lexicographically smaller peer id dials and the other waits — one rule, evaluated identically
 * on both devices from facts they already share, so it needs no negotiation and cannot deadlock.
 *
 * Without it both ends hold a half-open handshake, each waiting for the other to answer on a
 * connection the other never made.
 *
 * Takes whatever string both ends can compare. Before a connection exists that is whatever the
 * medium's announcement carried — a BLE advertisement's hint, a LAN datagram's full peer id —
 * and the order is the same either way.
 */
export const shouldDial = (self: string, other: string): boolean => self < other;

/**
 * A peer heard from, and where. Announcements repeat — several times a second on some radios,
 * every second or two on a multicast group — so a device is "found" once and only forgotten
 * after it has genuinely gone quiet.
 *
 * `T` is whatever the medium needs to reach it again: a peripheral id on BLE, a host and port
 * on a LAN. It is not an identity and must not be treated as one.
 */
export interface Sighting<T> {
  /** What the announcement called the device: a hint, a peer id — whatever both ends compare. */
  readonly key: string;
  where: T;
  seenAt: number;
}

export interface DiscoveryOptions {
  /** How long a peer stays known after its last announcement. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_TTL_MS = 15_000;

/**
 * Who is nearby, from a stream of announcements that repeat.
 *
 * `sighted` answers `true` once per peer rather than once per announcement, because a scan with
 * duplicates enabled reports the same device continuously and a transport that attached on every
 * one would rebuild the link several times a second.
 *
 * **A connected peer is not forgotten for going quiet.** Two iOS devices that are already
 * connected stop surfacing each other's advertisements entirely, so a TTL alone would drop a peer
 * precisely while it was working — `keep` is how the transport says a link is live.
 */
export function createDiscovery<T>(options: DiscoveryOptions = {}) {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const clock = options.now ?? (() => Date.now());
  const seen = new Map<string, Sighting<T>>();

  return {
    /** `true` when this is the first sighting, which is when a caller should attach. */
    sighted: (key: string, where: T): boolean => {
      const held = seen.get(key);
      if (held !== undefined) {
        held.seenAt = clock();
        held.where = where;
        return false;
      }
      seen.set(key, { key, where, seenAt: clock() });
      return true;
    },
    /** Where this peer last announced from — what `dial` takes, and it can change. */
    where: (key: string): T | undefined => seen.get(key)?.where,
    /** Keys not heard from inside the window, minus the ones `keep` says are live. */
    lost: (keep: (key: string) => boolean): readonly string[] => {
      const now = clock();
      const gone: string[] = [];
      for (const [key, sighting] of seen) {
        if (now - sighting.seenAt <= ttl) continue;
        if (keep(key)) {
          // connected and silent is the normal state of a paired iOS device, not a departure
          sighting.seenAt = now;
          continue;
        }
        seen.delete(key);
        gone.push(key);
      }
      return gone;
    },
    forget: (key: string): void => void seen.delete(key),
    known: (): number => seen.size,
  };
}

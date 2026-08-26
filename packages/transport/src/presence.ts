import type { PartitionKey, PeerId, Row } from "@syncmesh/kernel";
import type { VerifiedPresence } from "@syncmesh/wire";

import { createHub, type Unsubscribe } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";

/** One peer's current value for a topic, as a reader sees it. */
export interface PresenceEntry {
  readonly peerId: PeerId;
  /** The account the peer's grant names, when one is known — two tabs of one person share it. */
  readonly account: string | undefined;
  readonly value: Row;
  /** When this value was admitted here. */
  readonly at: Temporal.Instant;
  readonly expires: number;
  /** The bytes it arrived as, for a hop that forwards rather than re-signs. */
  readonly wire: Uint8Array;
}

/** What an admitted value touched, so a listener knows which readers to wake. */
export interface PresenceTouch {
  readonly topic: string;
  readonly partition: PartitionKey;
}

export interface PresenceStore {
  /**
   * Takes a value if it is newer than what this peer's session already sent and not already
   * stale; `false` means drop it — a gossip echo, a reordered frame, or a dead value. The
   * conflation and the loop-breaker in one call (D16).
   */
  readonly admit: (verified: VerifiedPresence) => boolean;
  /** Live values for a topic in an instance, expired ones pruned. */
  readonly peers: (topic: string, partition: PartitionKey) => readonly PresenceEntry[];
  /** Every live value, for a hop that must hand a joiner the current state. */
  readonly all: () => readonly PresenceEntry[];
  /** Fires once per admitted change, with the topic and instance it touched. */
  readonly subscribe: (listener: (touched: PresenceTouch) => void) => Unsubscribe;
  readonly size: () => number;
}

export interface PresenceStoreOptions {
  readonly now?: () => Temporal.Instant;
  /** Resolves a peer's account, so readers group a person's tabs. Absent, accounts are unknown. */
  readonly accountOf?: (peer: PeerId) => string | undefined;
  /** Sessions remembered for the loop-breaker; the oldest are forgotten past this. Default 1000. */
  readonly sessionLimit?: number;
}

const slot = (topic: string, partition: PartitionKey, peer: PeerId): string =>
  `${topic} ${String(partition)} ${String(peer)}`;

/**
 * The ephemeral tier's one data structure, used at every hop (D16): last value per
 * `(topic, instance, peer)`, highest count per session, expiry on read. Nothing here queues —
 * a value that arrives while another is unread replaces it, which is what makes a stalled
 * socket receive the current cursor rather than a backlog of dead ones.
 */
export function createPresenceStore(options: PresenceStoreOptions = {}): PresenceStore {
  const { accountOf, sessionLimit = 1000 } = options;
  const now = options.now ?? (() => Temporal.Now.instant());
  const held = new Map<string, PresenceEntry>();
  /** Highest count seen per session, insertion-ordered so the oldest can be forgotten. */
  const seen = new Map<string, number>();
  const hub = createHub<PresenceTouch>();

  const prune = (at: number): void => {
    for (const [key, entry] of held) if (entry.expires <= at) held.delete(key);
  };

  /**
   * The account, as it is known *now*. A value can arrive before its author's grant does — on a
   * fresh link, routinely — so resolving once at admit time would leave that peer anonymous
   * until it moved again. Re-resolved on read, and the entry replaced only when the answer
   * changes, so a reader comparing by identity still sees no churn.
   */
  const resolved = (key: string, entry: PresenceEntry): PresenceEntry => {
    const account = accountOf?.(entry.peerId);
    if (account === entry.account) return entry;
    const fresh: PresenceEntry = { ...entry, account };
    held.set(key, fresh);
    return fresh;
  };

  return {
    admit: ({ presence, wire }) => {
      const at = now();
      const ms = at.epochMilliseconds;
      // a value already stale on arrival is not news, however new its count
      if (presence.expires <= ms) return false;
      const last = seen.get(presence.session);
      if (last !== undefined && presence.count <= last) return false;
      seen.delete(presence.session);
      seen.set(presence.session, presence.count);
      while (seen.size > sessionLimit) {
        const oldest = seen.keys().next();
        if (oldest.done === true) break;
        seen.delete(oldest.value);
      }
      const key = slot(presence.topic, presence.partition, presence.peerId);
      const touched: PresenceTouch = { topic: presence.topic, partition: presence.partition };
      if (presence.value === null) {
        const departed = held.delete(key);
        if (departed) hub.emit(touched);
        return departed;
      }
      held.set(key, {
        peerId: presence.peerId,
        account: accountOf?.(presence.peerId),
        value: presence.value,
        at,
        expires: presence.expires,
        wire,
      });
      hub.emit(touched);
      return true;
    },
    peers: (topic, partition) => {
      prune(now().epochMilliseconds);
      const prefix = `${topic} ${String(partition)} `;
      return [...held]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => resolved(key, entry));
    },
    all: () => {
      prune(now().epochMilliseconds);
      return [...held].map(([key, entry]) => resolved(key, entry));
    },
    subscribe: hub.subscribe,
    size: () => {
      prune(now().epochMilliseconds);
      return held.size;
    },
  };
}

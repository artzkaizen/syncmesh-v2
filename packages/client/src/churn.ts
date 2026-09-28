import type { PeerId } from "@syncmesh/kernel";
import type { Neighbour, Transport } from "@syncmesh/transport";

import type { AdmissionFacts } from "./admission.js";

import { neighboursOf } from "./admission.js";

/**
 * Periodic random re-peering, so a saturated room cannot settle into islands (book ch. 17).
 *
 * The budget keeps each radio to the links it sustains, and it keeps the *best* ones — which is
 * correct per device and wrong for the room. Six phones that all admitted each other first stay
 * admitted to each other, and the seventh never gets in: a clique, indistinguishable from a
 * working mesh from the inside, and an island from anywhere else.
 *
 * Churn is the one thing that breaks it: now and then, give up a link so a slot opens and
 * discovery fills it with whoever is nearby now. The dropped peer is not banished — it is
 * discoverable the moment it advertises again, and may well be re-admitted, which is fine. The
 * point is that the *set* changes.
 *
 * **It gives up the least valuable link, not a random one.** Dropping uniformly at random is the
 * obvious implementation and the wrong one: sooner or later it takes the peer that was holding
 * everything this device still needs. libp2p prunes by a peer's value and never at random, and
 * the same facts the budget already ranks on — how far ahead of us a peer is, how many
 * partitions it shares — are what rank here. Churn exists at all only because there is no DHT
 * random-walk underneath to refresh the topology for us.
 *
 * **It only acts on a saturated medium.** A radio with a free slot can already admit a new peer,
 * so giving up a working link there would buy a reconnect and nothing else. In a small room this
 * costs exactly nothing, which is why it can be on by default.
 */

export interface ChurnOptions {
  /** How often to consider re-peering. Default 5 minutes: islands are a slow failure. */
  readonly everyMs?: number;
  /** A link given up to make room, for a log a person reads on a device. */
  readonly onChurned?: (peer: PeerId, transport: string) => void;
}

const DEFAULT_CHURN_MS = 5 * 60_000;

export interface Churn {
  /** Considers every transport now, as the timer would. Returns what it dropped. */
  readonly now: () => readonly PeerId[];
  readonly stop: () => void;
}

/**
 * Whether this medium is worth churning: it must be at its budget, hold more than one link, and
 * be able to close one.
 *
 * More than one, because dropping a device's only link is the island this exists to prevent.
 */
const saturated = (transport: Transport): boolean => {
  const reached = transport.reaches?.();
  const budget = transport.maxLinks?.();
  return (
    reached !== undefined &&
    budget !== undefined &&
    transport.drop !== undefined &&
    reached.size > 1 &&
    reached.size >= budget
  );
};

/**
 * The link worth least to this device: fewest events we are missing, fewest partitions in
 * common, and the peer id as the tie-break so two runs of the same facts agree.
 */
const cheapest = (neighbours: readonly Neighbour[]): PeerId | undefined =>
  [...neighbours].sort(
    (x, y) =>
      x.behind - y.behind ||
      x.shared - y.shared ||
      (x.peer < y.peer ? -1 : x.peer > y.peer ? 1 : 0),
  )[0]?.peer;

export function createChurn(
  transports: () => readonly Transport[],
  facts: () => AdmissionFacts,
  options: ChurnOptions = {},
): Churn {
  const round = (): readonly PeerId[] => {
    const dropped: PeerId[] = [];
    for (const transport of transports()) {
      if (!saturated(transport)) continue;
      const chosen = cheapest(neighboursOf(facts(), transport.reaches?.() ?? new Set()));
      if (chosen === undefined) continue;
      transport.drop?.(chosen);
      options.onChurned?.(chosen, transport.name);
      dropped.push(chosen);
    }
    return dropped;
  };

  const timer = setInterval(round, options.everyMs ?? DEFAULT_CHURN_MS);
  // a re-peering schedule is not a reason for a process to stay alive
  timer.unref?.();

  return {
    now: round,
    stop: () => clearInterval(timer),
  };
}

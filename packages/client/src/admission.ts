import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Neighbour, Transport } from "@syncmesh/transport";

import { admit } from "@syncmesh/transport";

/**
 * Holds each radio to the number of links it says it sustains (RFC-0012 §1, E28).
 *
 * The manager lives here rather than in a transport because the facts it selects on are the
 * **engine's**: how far ahead of us a peer is, and which partitions we share with it. A radio
 * knows neither, which is why RFC-0012 calls this a *mesh* manager and not a transport concern.
 *
 * Per device, over local knowledge, with no election and no coordinator. Two devices may keep
 * different neighbours and the mesh is still connected.
 */

/**
 * The facts this needs, and not the objects that hold them — the same reason `@syncmesh/ble`
 * takes a `BleRadio`. A test supplies three functions; `runTransports` supplies the engine's and
 * the registry's.
 */
export interface AdmissionFacts {
  /** What each peer was last acknowledged as holding, per author. */
  readonly acks: () => ReadonlyMap<PeerId, ReadonlyMap<PeerId, SeqNum>>;
  /** What this device holds, per author. */
  readonly held: () => ReadonlyMap<PeerId, SeqNum>;
  /** The partitions a device's grant names, or `undefined` where it has no grant here. */
  readonly partitionsOf: (device: PeerId) => readonly string[] | undefined;
  readonly self: PeerId;
}

/** How many events this peer holds that we lack, summed over every author. */
const behindBy = (facts: AdmissionFacts, peer: PeerId): number => {
  const theirs = facts.acks().get(peer);
  if (theirs === undefined) return 0;
  const ours = facts.held();
  let total = 0;
  for (const [author, seq] of theirs)
    total += Math.max(0, Number(seq) - Number(ours.get(author) ?? 0));
  return total;
};

/** Partitions this peer's grant names that ours does too. A peer sharing none can tell us nothing. */
const sharedWith = (facts: AdmissionFacts, peer: PeerId): number => {
  const mine = facts.partitionsOf(facts.self);
  const theirs = facts.partitionsOf(peer);
  if (mine === undefined || theirs === undefined) return 0;
  const held = new Set(mine);
  return theirs.filter((partition) => held.has(partition)).length;
};

/**
 * Whether this transport can be held to a budget at all: it must name its links, say what it
 * sustains, and be able to close one. A budget nothing can act on is a number, not a budget.
 */
export const boundable = (transport: Transport): boolean =>
  transport.reaches !== undefined &&
  transport.maxLinks !== undefined &&
  transport.drop !== undefined;

/**
 * Drops the links a transport is holding beyond its budget, keeping the ones {@link admit}
 * selects. A transport that cannot name its links, cannot close one, or declares no budget is
 * left alone — all three are needed before a drop is something anyone can act on.
 */
/**
 * What this device knows about each of a medium's peers, in the one shape everything that ranks
 * them takes. Shared by the budget and by churn so the two cannot disagree about which link is
 * worth least — libp2p's pruner ranks once, for the same reason.
 *
 * Quality is `0` for every peer, and honestly so: no transport reports RSSI or a throughput
 * average yet, and inventing one would make the tiebreak look considered when it is arbitrary.
 */
export const neighboursOf = (
  facts: AdmissionFacts,
  reached: ReadonlySet<PeerId>,
): readonly Neighbour[] =>
  [...reached].map((peer) => ({
    peer,
    behind: behindBy(facts, peer),
    shared: sharedWith(facts, peer),
    quality: 0,
    live: true, // every one of these is an open session; hysteresis applies to all of them alike
  }));

export function enforceBudget(transport: Transport, facts: AdmissionFacts): readonly PeerId[] {
  const reached = transport.reaches?.();
  const budget = transport.maxLinks?.();
  if (reached === undefined || budget === undefined || transport.drop === undefined) return [];
  if (reached.size <= budget) return [];

  const keeping = new Set(admit(neighboursOf(facts, reached), { maxLinks: budget }));
  const dropped = [...reached].filter((peer) => !keeping.has(peer));
  for (const peer of dropped) transport.drop(peer);
  return dropped;
}

/**
 * The links this device holds across **every** medium, held to one number.
 *
 * Separate from each medium's own budget, and both are needed. A BLE controller degrades past
 * roughly six links whatever the process can afford — that is a fact about the radio. A device
 * holding six BLE links, thirty LAN links and a relay is within every one of those budgets and
 * still out of file descriptors — that is a fact about the process. libp2p has only the second
 * (300 connections on a server, 100 in a browser); a mesh that runs on radios needs both.
 *
 * Over the cap, the cheapest links go first, ranked on the same facts the per-medium budget uses.
 */
export function enforceCeiling(
  transports: readonly Transport[],
  facts: AdmissionFacts,
  ceiling: number,
): readonly PeerId[] {
  const links = transports
    .filter(boundable)
    .flatMap((transport) =>
      [...(transport.reaches?.() ?? [])].map((peer) => ({ transport, peer })),
    );
  if (links.length <= ceiling) return [];

  const worth = new Map(
    neighboursOf(facts, new Set(links.map((link) => link.peer))).map((n) => [n.peer, n]),
  );
  const cheapestFirst = [...links].sort((x, y) => {
    const [a, b] = [worth.get(x.peer), worth.get(y.peer)];
    return (
      (a?.behind ?? 0) - (b?.behind ?? 0) ||
      (a?.shared ?? 0) - (b?.shared ?? 0) ||
      (x.peer < y.peer ? -1 : x.peer > y.peer ? 1 : 0)
    );
  });
  const dropped: PeerId[] = [];
  for (const link of cheapestFirst.slice(0, links.length - ceiling)) {
    link.transport.drop?.(link.peer);
    dropped.push(link.peer);
  }
  return dropped;
}

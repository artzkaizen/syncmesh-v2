import type { Mesh } from "@syncmesh/client";
import type { Cursors } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";

import type { DevtoolsAck, DevtoolsAuthor, DevtoolsParked, DevtoolsSync } from "../contract.js";

/**
 * Where this device has got to, and what is stuck below that.
 *
 * One panel and not two, because `recovery.list()` is literally `engine.quarantine().map(issueOf)`
 * — the same array, presented. Splitting them would teach a reader that coverage and quarantine
 * are different subjects, when they are the two halves of one question: how far has this device
 * got, and what refused to come with it.
 *
 * Everything here allocates: `acksAt()` builds a fresh `Map` per call and `coverage()` walks every
 * author. That is why `ack` is a channel a panel coalesces on rather than a hook it attaches to —
 * an acknowledgement fires per cursor exchange per link, and a device on three radios talking to
 * four peers will produce more of them than anyone can read.
 */

/** D13's pair per author, plus the parked events sitting below a gap that `holding` counts too. */
const authorsOf = (mesh: Mesh, synced: Cursors): readonly DevtoolsAuthor[] => {
  const ahead = mesh.engine.ahead();
  const holding = mesh.engine.holding();
  const peers = new Set<PeerId>([...synced.keys(), ...ahead.keys(), ...holding.keys()]);
  return [...peers].map((peer) => ({
    peer,
    cursor: synced.get(peer),
    ahead: ahead.get(peer)?.length ?? 0,
    holding: holding.get(peer)?.length ?? 0,
  }));
};

/**
 * What each peer last said, from the getter that kept the stamp.
 *
 * `acks()` maps the time away — every consumer of it, the compaction floor included, has no use
 * for one — so this reads `acksAt()`, which is the only surface that can tell "that peer is
 * behind" from "that peer has not been heard from since Tuesday".
 */
const acksOf = (mesh: Mesh): readonly DevtoolsAck[] =>
  [...mesh.engine.acksAt()].map(([peer, ack]) => ({
    peer,
    at: ack.at,
    ours: ack.cursors.get(mesh.engine.peerId),
    authors: ack.cursors.size,
  }));

/**
 * The quarantine as issues with their next step, and never as bytes.
 *
 * `explain` re-walks the parked list per call, so this is quadratic in a quarantine bounded at
 * 128 — sixteen thousand comparisons in the worst case, on a panel a person opened. The
 * alternative is this file deriving `next` itself, which would be a second copy of the one
 * mapping from verdict to advice, and the copy would be the stale one.
 */
const parkedOf = (mesh: Mesh): readonly DevtoolsParked[] =>
  mesh.recovery.list().map((issue) => {
    const plan = mesh.recovery.explain(issue.event);
    return {
      event: issue.event,
      author: issue.author,
      kind: issue.kind,
      verdict: issue.verdict,
      message: issue.message,
      next: plan?.next ?? "",
      retryWorthwhile: plan?.retryWorthwhile ?? false,
    };
  });

export const syncOf = (mesh: Mesh): DevtoolsSync => {
  // one reading: `coverage()` is cheap but two calls are two moments, and the scope is the claim
  // that makes these particular numbers true
  const coverage = mesh.engine.coverage();
  return {
    authors: authorsOf(mesh, coverage.synced),
    scope: coverage.scope,
    acks: acksOf(mesh),
    parked: parkedOf(mesh),
  };
};

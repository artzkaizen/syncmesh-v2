import type { RouteCandidate, RouteMessage, RoutePolicy, Transport } from "@syncmesh/transport";

import { ORDINARY_LINK, pickRoutes } from "@syncmesh/transport";

/**
 * Score the candidates and hand back the transports behind the survivors (RFC-0012 §2).
 *
 * Candidates are matched to their transport by identity rather than by name, so two mediums
 * configured under one name cannot collapse into each other — the name is the scorer's tie-break,
 * and a tie-break is not an identifier.
 *
 * A medium nothing has said anything about is treated as up. A send that turns out to be wrong
 * fails loudly and resyncs, where assuming down would keep a working link idle until it happened
 * to announce itself.
 */
export const scoreRoutes = (
  among: readonly Transport[],
  online: ReadonlyMap<Transport, boolean>,
  message: RouteMessage,
  policy: RoutePolicy | undefined,
): readonly Transport[] => {
  const owners = new Map<RouteCandidate, Transport>();
  const candidates = among.map((t) => {
    const candidate = {
      id: t.name,
      online: online.get(t) ?? true,
      ...(t.route?.() ?? ORDINARY_LINK),
    };

    /**
     * What this medium claims about peers, for routing: adjacency and transitive reach together.
     *
     * `reaches` is the links it holds and `delivers` is what it can carry to through them — a
     * relay's one socket and the room behind it. Routing wants both, because the question a frame
     * asks is "can you get this to P", not "is P on the other end of a cable". They stay separate
     * on the transport itself because `churn` counts `reaches` against `maxLinks` before closing
     * something, and a relay answering forty there would be told to hang up links it never had.
     *
     * Absent from both stays absent: a medium that tracks neither says nothing, which `pickRoutes`
     * reads as a shrug rather than a refusal.
     */
    const adjacency = t.reaches?.();
    const transitive = t.delivers?.();
    if (adjacency !== undefined || transitive !== undefined)
      Object.assign(candidate, { reaches: new Set([...(adjacency ?? []), ...(transitive ?? [])]) });
    owners.set(candidate, t);
    return candidate;
  });
  return pickRoutes(candidates, message, policy).flatMap((c) => owners.get(c) ?? []);
};

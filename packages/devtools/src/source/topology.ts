import type { Mesh } from "@syncmesh/client";

import type { DevtoolsLinks, DevtoolsSchema } from "../contract.js";
import type { LinkRing } from "./link-ring.js";

/**
 * Who this device can reach, over what, and what the attempts that failed had to say.
 *
 * `peers.graph()` is this device's own edges and no further: each medium that can enumerate its
 * links is asked, and one that cannot stays **silent** rather than reporting nothing as no peers.
 * Carrying that distinction into the contract is the whole reason `silent` exists — a relay socket
 * multiplexing a room reaches everyone in it and can name none of them, and a panel that drew that
 * as "0 peers" would report a working mesh as a dead one.
 *
 * There is no subscription behind any of this. `Peers` has none to offer, and `$status.subscribe`
 * captures the transport set at subscribe time, so a radio enabled afterwards never reaches an
 * existing subscription. A panel polls this at about a second and is told nothing it has to
 * un-learn; the link ring is what makes the poll enough, because the endings between two polls are
 * still in it.
 */
export const linksOf = (mesh: Mesh, ring: LinkRing): DevtoolsLinks => {
  const graph = mesh.peers.graph();
  const acks = mesh.engine.acksAt();
  return {
    self: graph.self,
    peers: graph.edges.map((edge) => ({
      peer: edge.peer,
      over: edge.over,
      ackedAt: acks.get(edge.peer)?.at,
    })),
    silent: graph.silent,
    // `all()` prunes expired entries as it reads, so what comes back is what is believed now
    routes: mesh.routes.all().map((route) => ({
      to: route.to,
      via: route.via,
      hops: route.hops,
      expiresAt: route.expiresAt,
    })),
    tally: ring.tally(),
    recent: ring.recent(),
  };
};

/**
 * The manifest, for the readers that enumerate rather than write.
 *
 * `sealed` is the field that earns this its place. A sealed partition still has rows in `events`
 * and still shows nothing through a handle, so without a way to ask *which kinds are sealed* a
 * panel has no vocabulary for the difference between a table that is empty and one this device
 * cannot read. Counting sealed events is fine; decoding one is not, and neither is quietly
 * presenting one as absent.
 */
export const schemaOf = (mesh: Mesh): DevtoolsSchema => ({
  tables: mesh.schema.entries.map((entry) => ({
    table: entry.table.name,
    partition: entry.partition,
    visibility: entry.visibility,
    sealed: mesh.schema.sealedKinds.has(entry.partition),
  })),
  sealedKinds: [...mesh.schema.sealedKinds],
  presence: mesh.schema.presence.map((topic) => topic.name),
});

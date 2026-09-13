import type { PeerId } from "@syncmesh/kernel";
import type { Transport } from "@syncmesh/transport";

/**
 * Who this device can reach, over what (book ch. 17). The graph is the substrate routing is
 * built on, and a settings screen reads the same thing a router would.
 *
 * **This device's own edges, and no further.** A peer names its neighbours only through route
 * advertisements, which are a protocol addition rather than a view over what is already here;
 * until those land, claiming a whole-mesh graph would be claiming knowledge nothing on this
 * device has. What it does say is exact: each medium that can enumerate its links is asked, and
 * a medium that cannot stays silent rather than reporting nothing as no peers.
 */

/** One reachable peer and the mediums reaching it — two entries for a peer on BLE and the relay. */
export interface PeerEdge {
  readonly peer: PeerId;
  /** Transport names, in the order the mediums were attached. */
  readonly over: readonly string[];
}

export interface PeerGraph {
  /** This device. */
  readonly self: PeerId;
  readonly edges: readonly PeerEdge[];
  /**
   * Mediums that cannot enumerate their links, so the graph says nothing about them. A relay
   * socket multiplexing a room is the ordinary case: it reaches whoever is in the room, and
   * knowing that is the room's business rather than the socket's.
   */
  readonly silent: readonly string[];
}

export interface Peers {
  /** A snapshot, whole: consumers diff it rather than being handed a diff to apply. */
  readonly graph: () => PeerGraph;
  /** Which mediums reach one peer right now; empty when none can say, or none do. */
  readonly reaching: (peer: PeerId) => readonly string[];
}

export function createPeers(deps: {
  readonly self: PeerId;
  readonly transports: () => readonly Transport[];
}): Peers {
  const graph = (): PeerGraph => {
    const over = new Map<PeerId, string[]>();
    const silent: string[] = [];
    for (const transport of deps.transports()) {
      const reaches = transport.reaches?.();
      // absent is "cannot say", which is not the same fact as "reaches nobody"
      if (reaches === undefined) {
        silent.push(transport.name);
        continue;
      }
      for (const peer of reaches) {
        const held = over.get(peer);
        if (held === undefined) over.set(peer, [transport.name]);
        else held.push(transport.name);
      }
    }
    return {
      self: deps.self,
      edges: [...over].map(([peer, names]) => ({ peer, over: names })),
      silent,
    };
  };

  return {
    graph,
    reaching: (peer) => graph().edges.find((edge) => edge.peer === peer)?.over ?? [],
  };
}

import type { PeerGraph } from "@syncmesh/client";
import type { LinkEvent } from "@syncmesh/transport";

import { useCallback, useRef, useSyncExternalStore } from "react";

/** The slice of a client this reads: the graph, and the two feeds that move it. */
export interface PeersSource {
  readonly $peers: { readonly graph: () => PeerGraph };
  readonly $transports: {
    readonly onLinkEvent: (listener: (event: LinkEvent) => void) => () => void;
  };
  readonly $status: { readonly subscribe: (listener: () => void) => () => void };
}

const sameEdges = (a: PeerGraph, b: PeerGraph): boolean =>
  a.self === b.self &&
  a.edges.length === b.edges.length &&
  a.edges.every((edge, i) => {
    const other = b.edges[i];
    return (
      other !== undefined &&
      other.peer === edge.peer &&
      other.over.length === edge.over.length &&
      other.over.every((name, j) => name === edge.over[j])
    );
  }) &&
  a.silent.length === b.silent.length &&
  a.silent.every((name, i) => name === b.silent[i]);

/**
 * Who this device can reach right now, over what (book ch. 17) — this device's own edges, and
 * no further, because a peer's neighbours are a fact nothing on this device has.
 *
 * Each edge is one peer and the mediums reaching it, so a device on BLE *and* the relay is one
 * edge with two names in `over`. `silent` lists the mediums that cannot enumerate their links at
 * all — a relay socket, which reaches the room and not a list — so an empty `edges` under a
 * silent relay is not "alone", and a screen has to read both before it says so.
 *
 * ```tsx
 * const { edges, silent } = usePeers();
 * // "2 nearby · relay" — the count is what can be counted, and the rest is named
 * ```
 */
export function usePeers(client: PeersSource): PeerGraph {
  const source = client;
  const held = useRef<PeerGraph | undefined>(undefined);
  const subscribe = useCallback(
    (notify: () => void) => {
      const offLinks = source.$transports.onLinkEvent(notify);
      // a medium going down takes its edges with it and reports that as a status, not a link
      const offStatus = source.$status.subscribe(notify);
      return () => {
        offLinks();
        offStatus();
      };
    },
    [source],
  );
  const snapshot = useCallback(() => {
    const next = source.$peers.graph();
    const previous = held.current;
    if (previous !== undefined && sameEdges(previous, next)) return previous;
    held.current = next;
    return next;
  }, [source]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

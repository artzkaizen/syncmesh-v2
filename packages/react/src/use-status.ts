import type { ForcedMedium, MeshHealth, MeshStatus } from "@syncmesh/client";
import type { LinkEvent, Transport, TransportCondition, TransportKind } from "@syncmesh/transport";

import { useCallback, useRef, useSyncExternalStore } from "react";

/** The slice of a client this reads — `$status`, and `$transports` for what each medium reaches. */
export interface StatusSource {
  readonly $status: {
    readonly get: () => MeshStatus;
    readonly subscribe: (listener: () => void) => () => void;
  };
  readonly $transports: {
    readonly list: () => readonly Transport[];
    readonly onLinkEvent: (listener: (event: LinkEvent) => void) => () => void;
    readonly forced: () => readonly ForcedMedium[];
  };
}

/** One medium, as a settings screen renders it: what it is, how it is, and who it reaches. */
export interface Source {
  readonly kind: TransportKind;
  /** `ok`, or a word a person can act on — `radio-off`, `no-permission-central`, `backgrounded`. */
  readonly condition: TransportCondition;
  /**
   * Distinct peers this medium currently has a proven link to; `undefined` for a medium that
   * cannot enumerate its links. A relay socket is the ordinary case — it reaches whoever is in
   * the room, and the room is not the socket's to count.
   */
  readonly reaches: number | undefined;
  /**
   * Somebody put this medium in its condition by hand — a devtool, a settings toggle — as against
   * the medium being there on its own. The one reading that separates *this radio is off* from
   * *somebody turned this radio off*, which is the difference between a bug and a switch.
   */
  readonly forced: boolean;
}

export interface Reading {
  /** Worst first: `blocked-recovery`, `offline`, `catching-up`, `local-ready`. */
  readonly health: MeshHealth;
  /** Keyed by the transport's own name — `ble({ id: "nearby" })` is `nearby` — not by medium. */
  readonly sources: ReadonlyMap<string, Source>;
}

const sameSource = (a: Source, b: Source): boolean =>
  a.kind === b.kind &&
  a.condition === b.condition &&
  a.reaches === b.reaches &&
  a.forced === b.forced;

const same = (a: Reading, b: Reading): boolean => {
  if (a.health !== b.health || a.sources.size !== b.sources.size) return false;
  for (const [name, source] of a.sources) {
    const other = b.sources.get(name);
    if (other === undefined || !sameSource(source, other)) return false;
  }
  return true;
};

const read = (client: StatusSource): Reading => {
  const status = client.$status.get();
  const media = client.$transports.list();
  const held = new Set(client.$transports.forced().map((one) => one.name));
  const sources = new Map<string, Source>();
  for (const [name, source] of status.sources) {
    const medium = media.find((one) => one.name === name);
    sources.set(name, {
      condition: source.condition,
      forced: held.has(name),
      kind: source.kind,
      reaches: medium?.reaches?.().size,
    });
  }
  return { health: status.health, sources };
};

/**
 * How the mesh is doing, per medium, as React state — the reading a settings screen, a header
 * badge and a "why is nothing syncing" panel all draw from (book ch. 18).
 *
 * Diagnosis rather than a boolean: `condition` is a word a person can act on, `reaches` says
 * whether a medium that is `ok` has actually found anybody, and `forced` says whether the state
 * was chosen. A red dot tells nobody anything; "Bluetooth is off — turn it on to sync with nearby
 * devices" is what this makes possible.
 *
 * Re-renders when a source changes state or a link is proven or lost, and not otherwise: the
 * snapshot keeps its identity until a field actually differs.
 *
 * ```tsx
 * const { health, sources } = useStatus();
 * const ble = sources.get("nearby");
 * if (ble?.condition === "radio-off") return <Hint>Bluetooth is off.</Hint>;
 * if (ble?.reaches === 0) return <Hint>Nobody nearby yet.</Hint>;
 * ```
 */
export function useStatus(client: StatusSource): Reading {
  const source = client;
  const held = useRef<Reading | undefined>(undefined);
  const subscribe = useCallback(
    (notify: () => void) => {
      const offStatus = source.$status.subscribe(notify);
      // a link proven or closed moves `reaches` without moving any source's condition
      const offLinks = source.$transports.onLinkEvent(notify);
      return () => {
        offStatus();
        offLinks();
      };
    },
    [source],
  );
  const snapshot = useCallback(() => {
    const next = read(source);
    const previous = held.current;
    if (previous !== undefined && same(previous, next)) return previous;
    held.current = next;
    return next;
  }, [source]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

import type { Mesh, SourceStatus } from "@syncmesh/client";
import type { Unsubscribe } from "@syncmesh/engine";
import type { Transport } from "@syncmesh/transport";

import type { DevtoolsMedium } from "../contract.js";

/**
 * Every medium currently attached, and the one fact about it that nothing on `Mesh` will hand over.
 *
 * `condition` comes from `$status` and answers *what does this radio say about itself*.
 * `onStatus` answers a different question — *is it up* — and the two disagree in the case that
 * matters: a medium whose `condition()` reads `ok` while its own status hub last said `false` is
 * one that believes it is fine and is carrying nothing. `$status` cannot show that, because it has
 * a single field to answer with and folds `online` into it; and `RunningTransports.online` is not
 * on the mesh surface. So this keeps its own reading, from the medium's own hub.
 *
 * It also **follows the set**, which `$status.subscribe` does not: that one captures
 * `deps.transports()` at subscribe time, so a radio a user enables from a settings screen never
 * reaches a subscription taken before it existed. Here the watch list is reconciled on every read,
 * which costs a walk over a handful of mediums and means a devtool stops going quietly deaf.
 */

interface Watched {
  online: boolean | undefined;
  /** Assigned after the object exists, because the callback that sets `online` closes over it. */
  release: Unsubscribe;
}

const mediumOf = (
  transport: Transport,
  status: SourceStatus | undefined,
  online: boolean | undefined,
): DevtoolsMedium => ({
  name: transport.name,
  kind: status?.kind ?? transport.kind ?? "unknown",
  condition: status?.condition ?? "unknown",
  online,
  maxLinks: transport.maxLinks?.(),
  // RFC-0019's default, said once here rather than left for each panel to guess at
  priority: transport.priority ?? 1,
});

export interface MediumWatch {
  readonly list: () => readonly DevtoolsMedium[];
  readonly close: () => void;
}

export function watchMediums(mesh: Mesh, changed: () => void): MediumWatch {
  const held = new Map<Transport, Watched>();

  /** Reconciles the watch list with the live set: new mediums are watched, gone ones let go. */
  const reconcile = (): readonly Transport[] => {
    const active = mesh.transports.list();
    const live = new Set(active);
    for (const [transport, watched] of held)
      if (!live.has(transport)) {
        watched.release();
        held.delete(transport);
      }
    for (const transport of active) {
      if (held.has(transport)) continue;
      const watched: Watched = { online: undefined, release: () => undefined };
      // a medium with no status hub stays `undefined` forever, which is "cannot say" and not "down"
      watched.release =
        transport.onStatus?.((up) => {
          watched.online = up;
          changed();
        }) ?? watched.release;
      held.set(transport, watched);
    }
    return active;
  };

  return {
    list: () => {
      const active = reconcile();
      const { sources } = mesh.status.get();
      return active.map((transport) =>
        mediumOf(transport, sources.get(transport.name), held.get(transport)?.online),
      );
    },
    close: () => {
      for (const watched of held.values()) watched.release();
      held.clear();
    },
  };
}

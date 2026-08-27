import type { PeerId } from "@syncmesh/kernel";

import { Temporal } from "@syncmesh/temporal";
import { readGrantOrigin } from "@syncmesh/wire";

/**
 * The grants circulating in one room, one per device — what a joiner is handed on its first
 * catch-up page. Keyed by device rather than by bytes so a re-issued, narrower grant *replaces*
 * the broad one it revokes: keyed by bytes the room accumulated every grant a device was ever
 * given and replayed the lot, which receivers resolved correctly but paid for in bandwidth that
 * only ever grew. Not a `GrantRegistry` — the relay holds no issuer key and verifies nothing.
 */
export interface GrantCache {
  /**
   * Takes a grant and answers whether the room should pass it on: `false` for an echo or for a
   * mint the room has already superseded, which is where those bytes stop. A grant whose core
   * will not decode is passed on uncached — the relay is not the place that judges grants, so
   * it forwards what it cannot read rather than dropping it.
   */
  readonly admit: (wire: Uint8Array) => boolean;
  /** Every wire held, newest mint per device, in the bytes it arrived as. */
  readonly all: () => readonly Uint8Array[];
}

export function createGrantCache(): GrantCache {
  const held = new Map<
    PeerId,
    { readonly issuedAt: Temporal.Instant; readonly wire: Uint8Array }
  >();

  return {
    admit: (wire) => {
      const origin = readGrantOrigin(wire);
      if (origin.isErr()) return true;
      const { device, issuedAt } = origin.value;
      const current = held.get(device);
      if (current !== undefined && Temporal.Instant.compare(issuedAt, current.issuedAt) <= 0)
        return false;
      held.set(device, { issuedAt, wire });
      return true;
    },
    all: () => [...held.values()].map((entry) => entry.wire),
  };
}

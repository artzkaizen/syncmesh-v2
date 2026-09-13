import type { DiscoveryOptions } from "@syncmesh/transport";

import { createDiscovery } from "@syncmesh/transport";

/**
 * Discovery in the radio's vocabulary: peers keyed by advertisement hint, found again by the
 * peripheral id the platform hands back.
 *
 * The rule and the bookkeeping live in `@syncmesh/transport` because they are true of every
 * medium that announces — what is BLE's here is only the name of the place a sighting points at.
 */
export { shouldDial } from "@syncmesh/transport";
export type { DiscoveryOptions, Sighting } from "@syncmesh/transport";
export { DEFAULT_TTL_MS } from "@syncmesh/transport";

export function discovery(options: DiscoveryOptions = {}) {
  const seen = createDiscovery<string>(options);
  return {
    ...seen,
    /** The peripheral id last advertised under a hint — what `connect` takes, and it can change. */
    peripheralFor: seen.where,
  };
}

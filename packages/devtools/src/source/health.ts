import type { Mesh } from "@syncmesh/client";

import type { DevtoolsIdentity, DevtoolsMedium, DevtoolsOverview } from "../contract.js";

/**
 * The two readings a person takes before anything else: who this device is, and whether it is well.
 *
 * Both are assembled from calls that cost nothing but are not free to *render* — `status.get()`
 * walks every medium and calls `recovery.list()` on the way past — so they are shaped as snapshots
 * a panel takes when something moved, never as a feed. Nothing here is cached: a cached health is
 * a health that is wrong for exactly as long as nobody looks.
 */

/**
 * Two accounts, and they are not the same question.
 *
 * The grant's account is what this *device* was admitted as, and it is the answer to "why will
 * nothing I write appear anywhere" — absent means nobody has admitted it at all. The session's
 * account is who the app is currently *acting as*, which a sign-in changes without touching the
 * grant. A screen that showed one of them would be wrong half the time.
 */
export const identityOf = (mesh: Mesh): DevtoolsIdentity => {
  const grant = mesh.grants.grantFor(mesh.engine.peerId);
  const principal = mesh.auth.principal();
  const { expiresAt } = mesh.auth.status();
  return {
    peer: mesh.engine.peerId,
    account: grant?.account,
    role: grant?.role,
    partitions: grant?.partitions ?? [],
    session:
      principal === undefined ? undefined : { account: principal.account, role: principal.role },
    sessionExpiresAt: expiresAt ?? undefined,
  };
};

export interface OverviewDeps {
  /**
   * Whether `mesh.settled()` has resolved. The source awaits it once and hands the flag in,
   * because a getter cannot await and a promise nothing re-announces cannot be a channel.
   */
  readonly settled: () => boolean;
  /**
   * The mediums, from the watcher that follows the transport set. `$status` alone cannot say
   * whether a radio's own hub last called it down, and that is the reading which catches a medium
   * that believes it is fine and is carrying nothing.
   */
  readonly mediums: () => readonly DevtoolsMedium[];
}

export const overviewOf = (mesh: Mesh, deps: OverviewDeps): DevtoolsOverview => ({
  health: mesh.status.get().health,
  mediums: deps.mediums(),
  handles: mesh.inspect.handles(),
  running: mesh.running(),
  settled: deps.settled(),
  peers: mesh.peers.graph().edges.length,
  grants: mesh.grants.all().length,
  parked: mesh.engine.quarantine().length,
});

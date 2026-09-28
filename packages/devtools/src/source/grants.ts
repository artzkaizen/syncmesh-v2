import type { Mesh } from "@syncmesh/client";

import { Temporal } from "@syncmesh/temporal";

import type { DevtoolsGrant, DevtoolsGrants } from "../contract.js";

/**
 * The answer to the commonest support question in a permissioned mesh — *why will this device's
 * writes not appear anywhere* — and the surface with the most already built behind it.
 *
 * Three things a grant carries never come out of here. The **wire** is a signed bearer credential:
 * a grant rendered as fields is a diagnosis, and a grant rendered as bytes is a password on a
 * screen that somebody will photograph. The **wrapped keys** are the content keys for sealed
 * partitions; the partitions they name are a fact worth showing and the bytes are not. And the
 * **claims' values** are free-form facts an issuing server vouched for, which in practice is where
 * an email address ends up — a reader diagnosing a refusal needs to know a claim is there and
 * never needs to read it.
 */

/** Everything held, expired included: expiry is a staleness bound rather than a tombstone (D08). */
const projected = (
  grant: ReturnType<Mesh["grants"]["all"]>[number],
  now: Temporal.Instant,
): DevtoolsGrant => ({
  device: grant.device,
  account: grant.account,
  role: grant.role,
  partitions: grant.partitions,
  sealed: (grant.keys ?? []).map((key) => key.partition),
  claims: Object.keys(grant.claims),
  issuedAt: grant.issuedAt,
  expiresAt: grant.expiresAt,
  expired: Temporal.Instant.compare(now, grant.expiresAt) > 0,
});

/**
 * How far ahead "expiring" looks.
 *
 * A day, because the window is a reading rather than a decision: nothing here renews anything, and
 * what an operator wants to see is the device that will stop working before they next open this
 * panel. A shorter window hides the problem until it is one.
 */
export const EXPIRING_WITHIN = Temporal.Duration.from({ hours: 24 });

export const grantsOf = (mesh: Mesh, now: () => Temporal.Instant): DevtoolsGrants => {
  const at = now();
  // `grantFor` reads an expired grant as absent, which is right for deciding and wrong for
  // showing: a device whose grant lapsed an hour ago is exactly the one a reader came here about
  const all = mesh.grants.all().map((grant) => projected(grant, at));
  return {
    own: all.find((grant) => grant.device === mesh.engine.peerId),
    all,
    expiring: mesh.grants.expiring(EXPIRING_WITHIN).map((grant) => projected(grant, at)),
    disputes: mesh.accounts.disputes().map((dispute) => ({
      device: dispute.device,
      partition: dispute.partition,
      linked: dispute.linked,
      granted: dispute.granted,
    })),
  };
};

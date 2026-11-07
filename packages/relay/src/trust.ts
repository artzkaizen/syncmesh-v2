import type { PartitionKey, PeerId } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { Temporal, addToInstant } from "@syncmesh/temporal";
import { verifyGrant } from "@syncmesh/wire";

import type { RoomState } from "./state.js";

/**
 * What a grant-gated room trusts (D40): public keys only. The room verifies grants against these
 * and serves each socket the partitions its grant names; it holds no private key, mints nothing,
 * and reads no payload — the partition is in the clear in every event core, which is all the
 * narrowing needs.
 *
 * @example
 * ```ts
 * startRelay({ posture: { trust: { issuers: [authority.peerId] }, announce: false } });
 * ```
 */
export interface RoomTrust {
  /** The issuers whose grants admit a device. One is the usual number; a key rotation needs two. */
  readonly issuers: readonly PeerId[];
  /** How long past `expiresAt` a grant still admits, for a device renewing late. Default none. */
  readonly grace?: Temporal.Duration;
  /** How long a joiner has to present a grant before it is refused as `ungranted`. Default 5 s. */
  readonly wait?: Temporal.Duration;
}

/** The refusal codes a gated room speaks, each frozen in `relay-vectors.json`. */
export const UNGRANTED = "ungranted";
export const REVOKED = "revoked";
export const REGRANTED = "regranted";

export const UNGRANTED_MESSAGE = "no grant from an issuer this room trusts names this device";
export const REVOKED_MESSAGE = "this device's grant no longer covers what it was served";
export const REGRANTED_MESSAGE = "this device was granted more; join again to be served it";

const DEFAULT_WAIT = Temporal.Duration.from({ seconds: 5 });

export const grantWait = (trust: RoomTrust): Temporal.Duration => trust.wait ?? DEFAULT_WAIT;

/**
 * A grant's wire, verified against the room's issuers, or `undefined` when none signed it. Expiry
 * is judged `grace` earlier than now, so a grant inside its grace still reads as live.
 */
function verified(room: RoomState, wire: Uint8Array): Grant | undefined {
  const trust = room.trust;
  if (trust === undefined) return undefined;
  const judged =
    trust.grace === undefined ? room.now() : addToInstant(room.now(), trust.grace.negated());
  for (const issuer of trust.issuers) {
    const grant = verifyGrant(wire, issuer, judged);
    if (grant.isOk()) return grant.value;
  }
  return undefined;
}

/** The grant this room holds for a device, verified, or `undefined` when it holds none that is. */
export function entitlement(room: RoomState, device: PeerId): Grant | undefined {
  const wire = room.grants.wireFor(device);
  const grant = wire === undefined ? undefined : verified(room, wire);
  return grant?.device === device ? grant : undefined;
}

/** Whether a grant has run out by the room's clock, grace included. */
export function lapsed(room: RoomState, grant: Grant): boolean {
  const grace = room.trust?.grace;
  const until = grace === undefined ? grant.expiresAt : addToInstant(grant.expiresAt, grace);
  return Temporal.Instant.compare(room.now(), until) > 0;
}

/** Whether two grants name the same partitions, in any order. */
export const sameSet = (a: readonly PartitionKey[], b: readonly PartitionKey[]): boolean =>
  a.length === b.length && a.every((p) => b.includes(p));

/**
 * A grant for `device` just entered the room's cache: hang up on its socket if what it may read
 * changed (D40). Narrower, or gone, is `revoked`; wider is `regranted`. Both are non-fatal — the
 * device re-joins and the join is the one place that decides what a socket is served, so there
 * is no second code path that re-filters a live socket in place.
 */
export function reconsider(room: RoomState, device: PeerId): void {
  const client = room.clients.get(device);
  if (client?.granted === undefined) return;
  const grant = entitlement(room, device);
  if (grant === undefined) {
    client.refuse(REVOKED, REVOKED_MESSAGE);
    return;
  }
  if (sameSet(grant.partitions, client.granted.partitions)) return;
  const narrowed = client.granted.partitions.some((p) => !grant.partitions.includes(p));
  if (narrowed) client.refuse(REVOKED, REVOKED_MESSAGE);
  else client.refuse(REGRANTED, REGRANTED_MESSAGE);
}

/**
 * One grant arriving at the room, from a socket or another instance: whether to pass it on.
 *
 * A gated room caches only grants that verify against its issuers. The cache keeps one grant per
 * device, newest mint wins, and reads the mint time without a signature check — so an ungated
 * cache lets anyone evict a device's real grant with a forged core stamped later. Where that grant
 * is the ticket, that eviction is a revocation anyone could send. An ungated room keeps today's
 * rule: it forwards what it cannot judge.
 */
export function admitGrant(room: RoomState, wire: Uint8Array): boolean {
  if (room.trust === undefined) return room.grants.admit(wire);
  const grant = verified(room, wire);
  if (grant === undefined || !room.grants.admit(wire)) return false;
  reconsider(room, grant.device);
  return true;
}

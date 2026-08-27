import type { PeerId } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import { verifyGrant, type Grant, type GrantError } from "./grant.js";

/** What an engine holds about other peers' grants, so it can answer "who is this author?" offline. */
export interface GrantRegistry {
  /** Newest-issued wins; an older grant for the same device is ignored, so a replay cannot downgrade anyone. */
  readonly register: (wire: Uint8Array) => Result<Grant, GrantError>;
  /** The device's grant, or `undefined` once it has expired — staleness, not a tombstone. */
  readonly grantFor: (device: PeerId) => Grant | undefined;
  /** The exact bytes received, for byte-identical re-forwarding. */
  readonly wireFor: (device: PeerId) => Uint8Array | undefined;
  /** Every wire held; these travel first in every sync session. */
  readonly allWires: () => readonly Uint8Array[];
  /**
   * Every grant held, expired ones included — the same population `allWires` reports, decoded.
   * Expiry is a staleness bound rather than a tombstone (D08), so a lapsed grant still names the
   * account, role and partitions a renewal re-issues on; filtering here would leave an authority
   * unable to see the devices that most need renewing. Anything deciding what a device may do
   * must ask `grantFor`, which does read expired as absent.
   */
  readonly all: () => readonly Grant[];
  readonly onRegistered: (listener: (grant: Grant, wire: Uint8Array) => void) => () => void;
  /**
   * A grant dropped from this registry. The mirror of `onRegistered`, and what keeps a store
   * that remembers grants from resurrecting one on the next restart.
   */
  readonly onForgotten: (listener: (device: PeerId) => void) => () => void;
  /** Withdraws it here only; the propagating form is a `_revocations` row (E21). */
  readonly revoke: (device: PeerId) => void;
}

export interface GrantRegistryOptions {
  readonly issuer: PeerId;
  readonly now: () => Temporal.Instant;
}

export function createGrantRegistry(options: GrantRegistryOptions): GrantRegistry {
  const held = new Map<PeerId, { readonly grant: Grant; readonly wire: Uint8Array }>();
  const listeners = new Set<(grant: Grant, wire: Uint8Array) => void>();
  const forgotten = new Set<(device: PeerId) => void>();

  const register: GrantRegistry["register"] = (wire) => {
    const verified = verifyGrant(wire, options.issuer, options.now());
    if (verified.isErr()) return verified;
    const grant = verified.value;
    const current = held.get(grant.device);
    if (
      current !== undefined &&
      Temporal.Instant.compare(grant.issuedAt, current.grant.issuedAt) <= 0
    ) {
      return Result.ok(current.grant);
    }
    held.set(grant.device, { grant, wire });
    for (const listener of listeners) listener(grant, wire);
    return Result.ok(grant);
  };

  const live = (device: PeerId) => {
    const entry = held.get(device);
    return entry !== undefined &&
      Temporal.Instant.compare(options.now(), entry.grant.expiresAt) <= 0
      ? entry
      : undefined;
  };

  return {
    register,
    grantFor: (device) => live(device)?.grant,
    wireFor: (device) => live(device)?.wire,
    allWires: () => [...held.values()].map((e) => e.wire),
    all: () => [...held.values()].map((e) => e.grant),
    onRegistered: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onForgotten: (listener) => {
      forgotten.add(listener);
      return () => void forgotten.delete(listener);
    },
    revoke: (device) => {
      if (!held.delete(device)) return;
      for (const listener of forgotten) listener(device);
    },
  };
}

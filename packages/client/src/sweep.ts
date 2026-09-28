import type { StoreFailure, Unsubscribe } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { DetachRefused, ScopedStoreSet, StoreScope } from "@syncmesh/storage";
import type { GrantRegistry } from "@syncmesh/wire";

import { kindOf } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { global, local, user } from "@syncmesh/schema";
import { detachScope } from "@syncmesh/storage";

/** The three kinds every app has without a grant naming them — never granted, so never swept. */
const RESERVED_KINDS: ReadonlySet<string> = new Set([global.name, user.name, local.name]);

/**
 * Why an open store is one this device should not be holding.
 *
 * `no-grant`: no grant for this device is held at all — revoked, or never issued. `grant-lapsed`:
 * one is held but has expired, so a renewal would cover the scope again. `not-granted`: the live
 * grant does not name this scope.
 */
export type SweepReason = "no-grant" | "grant-lapsed" | "not-granted";

export interface SweepCandidate {
  readonly scope: StoreScope;
  readonly reason: SweepReason;
}

/** A candidate `detachScope` refused: it still holds writes no peer has acknowledged. */
export interface SweepRefusal extends SweepCandidate {
  /** Operation ids whose events no peer holds yet — what `DetachRefused` reported. */
  readonly unsent: readonly string[];
}

export interface SweepReport {
  readonly detached: readonly SweepCandidate[];
  /** Reported, not retried, and never bypassed: shipping the intent is what clears these. */
  readonly refused: readonly SweepRefusal[];
}

/**
 * The stores a grant no longer covers (plan §2.3): a store no live grant names is a store this
 * device should not be holding, and the grant is the one signed, replicated, revocable record
 * of what it may hold. Reserved kinds are never granted and never swept, and a scope with a
 * grant request in flight is excluded so that a fresh device is not swept while it onboards.
 */
export interface StoreSweep {
  /** The reading: every open store no live grant covers, with why. Cheap, no side effects. */
  readonly candidates: () => readonly SweepCandidate[];
  /**
   * Fires when a grant lands or is withdrawn from the registry. Expiry fires nothing — it is a
   * bound read against the clock, as `grantFor` reads it — so a screen re-reads on its own tick.
   */
  readonly subscribe: (listener: () => void) => Unsubscribe;
  /**
   * Detaches every candidate, whole (book ch. 13). A `DetachRefused` is reported and the store
   * stays; any other store failure ends the run as itself.
   */
  readonly sweep: () => Promise<ResultType<SweepReport, StoreFailure>>;
}

export interface SweepDeps {
  /** This device — the one whose grant decides what it may hold. */
  readonly self: PeerId;
  readonly grants: Pick<GrantRegistry, "grantFor" | "all" | "onRegistered" | "onForgotten">;
  /** The scopes this device holds open — `ScopedStoreSet.opened()`. */
  readonly scopes: () => readonly StoreScope[];
  /** Scopes a grant has been asked for and not yet answered; never candidates while it is open. */
  readonly requested: () => readonly StoreScope[];
  /** `detachScope` over the set, with the platform's deletion of the scope's files. */
  readonly detach: (scope: StoreScope) => Promise<ResultType<void, DetachRefused | StoreFailure>>;
}

export function createSweep(deps: SweepDeps): StoreSweep {
  const reasonFor = (scope: StoreScope): SweepReason | undefined => {
    if (scope === "user" || RESERVED_KINDS.has(kindOf(scope))) return undefined;
    const live = deps.grants.grantFor(deps.self);
    if (live !== undefined) return live.partitions.includes(scope) ? undefined : "not-granted";
    return deps.grants.all().some((grant) => grant.device === deps.self)
      ? "grant-lapsed"
      : "no-grant";
  };

  const candidates: StoreSweep["candidates"] = () => {
    const requested = new Set(deps.requested());
    const found: SweepCandidate[] = [];
    for (const scope of deps.scopes()) {
      if (requested.has(scope)) continue;
      const reason = reasonFor(scope);
      if (reason !== undefined) found.push({ scope, reason });
    }
    return found;
  };

  return {
    candidates,
    subscribe: (listener) => {
      const offs = [
        deps.grants.onRegistered(() => listener()),
        deps.grants.onForgotten(() => listener()),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    sweep: async () => {
      const detached: SweepCandidate[] = [];
      const refused: SweepRefusal[] = [];
      for (const candidate of candidates()) {
        const outcome = await deps.detach(candidate.scope);
        if (outcome.isOk()) {
          detached.push(candidate);
          continue;
        }
        if (outcome.error._tag !== "DetachRefused") return Result.err(outcome.error);
        refused.push({ ...candidate, unsent: outcome.error.unsent });
      }
      return Result.ok({ detached, refused });
    },
  };
}

/** What a mesh is handed to sweep over: the set its stores came from, and how to delete one. */
export interface SweepOver {
  readonly set: ScopedStoreSet;
  readonly remove: (scope: StoreScope) => Promise<void>;
}

/**
 * The sweep a mesh assembles, with the one fact only the mesh knows: whether this device is
 * asking for a grant.
 *
 * A bare `requestGrant()` names no scope, so it is read as covering **every** open store until a
 * grant for this device lands — the onboarding case the sweep must never race, because a fresh
 * device holds stores it has not been granted *yet*. `asked()` is what the mesh calls beside
 * `requestGrant`; the answer arriving through `onRegistered` clears it. No `over` means no sweep:
 * a mesh over one driver has nothing to shed but itself.
 */
export interface MeshSweep {
  /** Absent for a mesh over one driver, which has nothing to shed but itself. */
  readonly stores?: StoreSweep;
  /** This device asked for a grant: every open store is shielded until one lands. */
  readonly asked: () => void;
  readonly stop: () => void;
}

export function sweepFor(deps: {
  readonly self: PeerId;
  readonly grants: SweepDeps["grants"];
  readonly over: SweepOver | undefined;
}): MeshSweep {
  const { self, grants, over } = deps;
  let asking = false;
  const off = grants.onRegistered((grant) => {
    if (grant.device === self) asking = false;
  });
  const asked = (): void => void (asking = true);
  if (over === undefined) return { asked, stop: off };
  const stores = createSweep({
    self,
    grants,
    scopes: over.set.opened,
    requested: () => (asking ? over.set.opened() : []),
    detach: (scope) => detachScope(over.set, scope, { remove: () => over.remove(scope) }),
  });
  return { stores, asked, stop: off };
}

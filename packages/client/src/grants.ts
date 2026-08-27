import type { StoreFailure } from "@syncmesh/engine";
import type { JsonValue, PeerId } from "@syncmesh/kernel";
import type { InvalidPartitionKey } from "@syncmesh/kernel";
import type { GrantStore, SqlDriver } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { GrantError, GrantRegistry, Identity } from "@syncmesh/wire";

import { parsePartitionKey } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";
import { sqlGrantStore } from "@syncmesh/storage";
import { issueGrant, readGrantOrigin } from "@syncmesh/wire";

/** What flow B's approval screen fills in; `now` and the signature come from the mesh. */
export interface IssueRequest {
  readonly account: string;
  /** From the grant-request frame — attacker-writable, and binding it here is exactly the point. */
  readonly device: PeerId;
  readonly role?: string;
  readonly partitions: readonly string[];
  readonly claims?: Readonly<Record<string, JsonValue>>;
  readonly validFor: Temporal.Duration;
}

/** The registry every mesh has, plus minting where this process holds the issuer key. */
export interface MeshGrants extends GrantRegistry {
  /** Mints, registers locally (the issuer must validate the grantee too), and returns the wire bytes to send. Panics unless `createMesh` was given `issuerKey`. */
  readonly issue: (request: IssueRequest) => Result<Uint8Array, InvalidPartitionKey | GrantError>;
}

export interface MeshGrantsOptions {
  readonly issuerKey?: Identity;
  readonly now: () => Temporal.Instant;
}

/** What a load of stored grants found: how many came back, and how many the registry refused. */
export interface GrantsRestored {
  readonly restored: number;
  /** Grants that no longer verify — expired, almost always — dropped from the store on the way past. */
  readonly dropped: number;
}

/**
 * Fills the registry from the store, then keeps the two in step for the rest of the session.
 *
 * Every stored wire goes back in through `register`, so the issuer's signature is checked again
 * and an expired grant does not return: a store cannot launder a grant into something the
 * registry would not have accepted from a peer. What fails to come back is deleted rather than
 * left to be re-read on every boot.
 */
export async function rememberGrants(
  registry: GrantRegistry,
  store: GrantStore,
): Promise<Result<GrantsRestored, StoreFailure>> {
  const stored = await store.all();
  if (stored.isErr()) return stored;
  let restored = 0;
  let dropped = 0;
  for (const wire of stored.value) {
    const grant = registry.register(wire);
    if (grant.isOk()) {
      restored += 1;
      continue;
    }
    dropped += 1;
    // the device this wire named is unreadable now, so the only handle on it is the wire itself;
    // `readGrantOrigin` reads the core without verifying, which is all a delete needs
    const origin = readGrantOrigin(wire);
    if (origin.isOk()) await store.delete(origin.value.device);
  }
  registry.onRegistered((grant, wire) => void store.put(grant.device, wire));
  registry.onForgotten((device) => void store.delete(device));
  return Result.ok({ restored, dropped });
}

/** The grants this device already knew, back from its own database; nothing to restore without one. */
export async function restoreGrants(
  registry: GrantRegistry,
  driver: SqlDriver | undefined,
): Promise<Result<void, StoreFailure>> {
  if (driver === undefined) return Result.ok(undefined);
  const store = await sqlGrantStore(driver);
  if (store.isErr()) return store;
  return (await rememberGrants(registry, store.value)).map(() => undefined);
}

export function createMeshGrants(registry: GrantRegistry, options: MeshGrantsOptions): MeshGrants {
  const { issuerKey, now } = options;

  const issue: MeshGrants["issue"] = (request) => {
    if (issuerKey === undefined)
      return panic("createMesh was not given issuerKey; only the issuer can mint grants");
    return Result.gen(function* () {
      const partitions = [];
      for (const p of request.partitions) partitions.push(yield* parsePartitionKey(p));
      const base = {
        account: request.account,
        device: request.device,
        partitions,
        validFor: request.validFor,
        now: now(),
      };
      const withRole = request.role === undefined ? base : { ...base, role: request.role };
      const full =
        request.claims === undefined ? withRole : { ...withRole, claims: request.claims };
      const wire = issueGrant(issuerKey, full);
      yield* registry.register(wire);
      return Result.ok(wire);
    });
  };

  return { ...registry, issue };
}

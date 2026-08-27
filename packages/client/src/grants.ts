import type { Engine, StoreFailure } from "@syncmesh/engine";
import type { JsonValue, PartitionKey, PeerId } from "@syncmesh/kernel";
import type { InvalidPartitionKey } from "@syncmesh/kernel";
import type { GrantStore, SqlDriver } from "@syncmesh/storage";
import type { Grant, GrantError, GrantRegistry, Identity } from "@syncmesh/wire";

import { graceMillis, revokedAt } from "@syncmesh/engine";
import { parsePartitionKey, readRow } from "@syncmesh/kernel";
import { Result, TaggedError, panic } from "@syncmesh/result";
import { sqlGrantStore } from "@syncmesh/storage";
import { Temporal, addToInstant } from "@syncmesh/temporal";
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

/** `renew` was asked about a device this registry holds nothing for, so there is nothing to copy. */
export class NoGrantHeld extends TaggedError("NoGrantHeld")<{
  device: PeerId;
  message: string;
}> {}

/** `renew` was asked to readmit a device an authority revoked; a deliberate `issue` still may. */
export class DeviceRevoked extends TaggedError("DeviceRevoked")<{
  device: PeerId;
  partition: string;
  message: string;
}> {}

/** The registry every mesh has, plus minting where this process holds the issuer key. */
export interface MeshGrants extends GrantRegistry {
  /** Mints, registers locally (the issuer must validate the grantee too), and returns the wire bytes to send. Panics unless `createMesh` was given `issuerKey`. */
  readonly issue: (request: IssueRequest) => Result<Uint8Array, InvalidPartitionKey | GrantError>;
  /**
   * Grants that lapse inside `within`, soonest first, counting the ones that already have.
   *
   * The renewal loop D08 asks for, minus the timer: an authority calls this on whatever schedule
   * suits it — a poll, a wake-up, the top of a sync session — and `renew`s what comes back. Short
   * validity is only a containment for a stolen device if renewal is cheap, and a timer owned by
   * this library would be one nobody could test or align with their own scheduler.
   */
  readonly expiring: (within: Temporal.Duration) => readonly Grant[];
  /**
   * Re-issues the grant held for a device on the same account, role, partitions and claims, with
   * `validFor` measured afresh from now. The whole point is that a caller never restates the
   * request: derive it by hand and sooner or later one path drops `claims`, and the device
   * silently loses the `allow` rules that read them.
   */
  readonly renew: (
    device: PeerId,
    validFor: Temporal.Duration,
  ) => Result<Uint8Array, InvalidPartitionKey | GrantError | NoGrantHeld | DeviceRevoked>;
}

/**
 * What renewal must know about a device besides its grant, and cannot learn from the registry:
 * both facts live in synced rows, and `MeshGrants` holds no engine.
 *
 * Without `revokedAt`, the loop `expiring` prescribes **readmits every device the authority
 * revoked** — `renew` re-mints with a fresh `issuedAt`, and a grant issued after a revocation is
 * one the rung deliberately lets through, because that is how a deliberate re-issue readmits.
 * Automatic renewal must not be that path. A person calling `issue` still is.
 */
export interface StandingOf {
  /** When this device's powers were withdrawn in an instance, if they were (E21). */
  readonly revokedAt?: (device: PeerId, partition: PartitionKey) => Temporal.Instant | undefined;
  /** How much sooner than `expiresAt` an instance stops trusting a grant, if it says (RFC-0016). */
  readonly graceMillis?: (partition: PartitionKey) => number | undefined;
}

export interface MeshGrantsOptions {
  readonly issuerKey?: Identity;
  readonly now: () => Temporal.Instant;
  /** Absent, renewal sees only grants — right for a mesh with no authority, wrong for one with. */
  readonly standing?: StandingOf;
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

/**
 * The two synced facts renewal needs, read off whichever engine exists by the time it is asked.
 * Before boot there is none and both answer "nothing known", which is the honest answer for a
 * mesh that has not opened its log yet — and renewal cannot run before then anyway.
 */
export const standingOf = (engineOf: () => Engine | undefined): StandingOf => ({
  revokedAt: (device, partition) => {
    const engine = engineOf();
    return engine === undefined ? undefined : revokedAt(engine, partition, device);
  },
  graceMillis: (partition) => {
    const engine = engineOf();
    if (engine === undefined) return undefined;
    const state = engine.state();
    return graceMillis(partition, (table, key) => readRow(state, table, key));
  },
});

/**
 * The registry plus its renewal seams, and the one call that closes the loop once an engine
 * exists. Grants are built before the engine that holds the rows renewal must consult — the
 * validator needs `grantFor` to boot — so the dependency runs backwards for exactly that window,
 * and `bind` is where it is repaid rather than a construction order nobody can follow.
 */
export function openGrants(registry: GrantRegistry, options: MeshGrantsOptions) {
  let engine: Engine | undefined;
  const grants = createMeshGrants(registry, {
    ...options,
    standing: standingOf(() => engine),
  });
  return { grants, bind: (booted: Engine) => void (engine = booted) };
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

  const standing = options.standing ?? {};

  /** The instant an instance stops trusting this grant: its expiry, less whatever grace it declares. */
  const cutoff = (grant: Grant): Temporal.Instant => {
    const graces = grant.partitions.map((p) => standing.graceMillis?.(p) ?? 0);
    // the strictest instance decides: a grant refused anywhere is one worth renewing everywhere
    return grant.expiresAt.subtract({ milliseconds: Math.max(0, ...graces) });
  };

  /** The instance that withdrew this device's powers since the grant was issued, if one did. */
  const revokedIn = (grant: Grant): PartitionKey | undefined =>
    grant.partitions.find((partition) => {
      const at = standing.revokedAt?.(grant.device, partition);
      return at !== undefined && Temporal.Instant.compare(grant.issuedAt, at) <= 0;
    });

  const expiring: MeshGrants["expiring"] = (within) => {
    const deadline = addToInstant(now(), within);
    return (
      registry
        .all()
        .filter((grant) => Temporal.Instant.compare(cutoff(grant), deadline) <= 0)
        // a revoked device is not "expiring", it is finished: listing it invites the loop to
        // readmit it, and a caller reading this list has no way to know it should not
        .filter((grant) => revokedIn(grant) === undefined)
        .sort((a, b) => Temporal.Instant.compare(cutoff(a), cutoff(b)))
    );
  };

  const renew: MeshGrants["renew"] = (device, validFor) => {
    // `all`, not `grantFor`: a grant that lapsed while the device was dark is the one most worth
    // renewing, and reading it back is not a right — the re-issue is signed here either way
    const held = registry.all().find((grant) => grant.device === device);
    if (held === undefined)
      return Result.err(new NoGrantHeld({ device, message: `no grant held for ${device}` }));
    const revoked = revokedIn(held);
    if (revoked !== undefined) {
      return Result.err(
        new DeviceRevoked({
          device,
          partition: String(revoked),
          message: `${device} was revoked from ${String(revoked)}; issue a fresh grant to readmit it`,
        }),
      );
    }
    const base = {
      account: held.account,
      device,
      partitions: held.partitions,
      claims: held.claims,
      validFor,
    };
    const request = held.role === undefined ? base : { ...base, role: held.role };
    return issue(request);
  };

  return { ...registry, issue, expiring, renew };
}

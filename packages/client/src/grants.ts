import type { JsonValue, PeerId } from "@syncmesh/kernel";
import type { InvalidPartitionKey } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";
import type { GrantError, GrantRegistry, Identity } from "@syncmesh/wire";

import { parsePartitionKey } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";
import { issueGrant } from "@syncmesh/wire";

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

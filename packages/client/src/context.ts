import type { PartitionKey, PeerId } from "@syncmesh/kernel";
/** The two fields placement reads; any `SchemaEntry<P>` fits. */
export interface PlacementEntry {
  readonly partition: string;
  readonly visibility: "partition" | "authority";
}
import type { Grant } from "@syncmesh/wire";

import { NoGrant } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import { NoActivePartition, UnknownPartitionKind } from "./errors.js";

/** Where a write to the table goes: an instance, the device only, or nowhere in particular (global). */
export interface Placement {
  readonly partition?: PartitionKey;
  readonly local?: true;
}

export interface Context {
  readonly activate: (instance: PartitionKey) => Result<void, UnknownPartitionKind>;
  readonly active: (kind: string) => PartitionKey | undefined;
  readonly placementFor: (entry: PlacementEntry) => Result<Placement, NoActivePartition | NoGrant>;
}

export interface ContextOptions {
  readonly kinds: readonly string[];
  readonly peerId: PeerId;
  readonly grantFor: (peer: PeerId) => Grant | undefined;
}

const kindOf = (instance: PartitionKey) => String(instance).slice(0, String(instance).indexOf(":"));

/** The active instance per kind: set by `activate`, or implied when the grant lists exactly one. */
export function createContext(options: ContextOptions): Context {
  const { kinds, peerId, grantFor } = options;
  const declared = new Set(kinds);
  const chosen = new Map<string, PartitionKey>();

  const implied = (kind: string): PartitionKey | undefined => {
    const listed = (grantFor(peerId)?.partitions ?? []).filter((p) => kindOf(p) === kind);
    return listed.length === 1 ? listed[0] : undefined;
  };
  const active = (kind: string) => chosen.get(kind) ?? implied(kind);

  const placementFor: Context["placementFor"] = (entry) => {
    const kind = String(entry.partition);
    if (entry.visibility === "authority" || kind === "global") return Result.ok({});
    if (kind === "local") return Result.ok({ local: true });
    if (kind === "user") {
      const grant = grantFor(peerId);
      if (grant === undefined)
        return Result.err(new NoGrant({ peer: peerId, message: "no grant held for this device" }));
      return Result.ok({ partition: parsePartitionKey(`user:${grant.account}`).unwrap() });
    }
    const instance = active(kind);
    if (instance === undefined) {
      return Result.err(
        new NoActivePartition({
          kind,
          message: `nothing active for ${kind}: call activate("${kind}:<id>")`,
        }),
      );
    }
    return Result.ok({ partition: instance });
  };

  return {
    activate: (instance) => {
      const kind = kindOf(instance);
      if (!declared.has(kind))
        return Result.err(
          new UnknownPartitionKind({ kind, message: `the manifest declares no kind "${kind}"` }),
        );
      chosen.set(kind, instance);
      return Result.ok(undefined);
    },
    active,
    placementFor,
  };
}

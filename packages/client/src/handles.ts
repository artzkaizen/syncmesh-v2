import type { Principal } from "@syncmesh/engine";
import type { InvalidPartitionKey, PartitionKey } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { ColumnsMap, PartitionTree, PresenceMap, Roles, Schema } from "@syncmesh/schema";
import type { SqlDialect, SqlDriver } from "@syncmesh/storage";

import { meshDrizzle, type MeshHandle } from "@syncmesh/drizzle";
import { parsePartitionKey } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";

import type { Booted } from "./boot.js";

/** The data surface of one handle: Drizzle in, events out (D20), in the connection's dialect. */
export type Handle<D extends SqlDialect = "sqlite"> = MeshHandle<D>;

export interface OnOptions {
  /**
   * Act as this principal: `read()` sources admit only rows their `read` rule admits, and a
   * write their rules deny rejects the transaction before COMMIT. The events stay this device's.
   */
  readonly as?: Principal;
}

/** `mesh.on`: the Drizzle surface for one instance, acting as one principal. */
export type OpenHandle<D extends SqlDialect> = (
  instance?: string,
  options?: OnOptions,
) => ResultType<Handle<D>, InvalidPartitionKey>;

/**
 * The handle cache: one Drizzle surface per `(instance, principal)` pair, built on first ask.
 *
 * The pair is the identity because it is exactly what the handle bakes in — the pin every write
 * is stamped with, and the actor every read is filtered for. Handing back the same object for
 * the same pair is what lets a caller compare handles, and what keeps a server that takes a
 * request per tenant from building a Drizzle instance per request.
 */
export function openHandles<
  P extends PartitionTree,
  RS extends Roles<P>,
  C extends ColumnsMap,
  D extends SqlDialect,
  PC extends PresenceMap,
>(schema: Schema<P, RS, C, PC>, booted: Booted): OpenHandle<D> {
  const handles = new Map<string, Handle<D>>();
  const { engine, validate } = booted;

  return (instance, options = {}) => {
    // outside the generator: a missing connection is a setup mistake and must throw as itself
    const driver =
      booted.driver ??
      panic(
        "this mesh has no SQL connection: omit `store` for the durable default, or pass `driver`",
      );
    return Result.gen(function* () {
      const partition: PartitionKey | undefined =
        instance === undefined ? undefined : yield* parsePartitionKey(instance);
      const key = JSON.stringify([instance ?? null, options.as ?? null]);
      const held = handles.get(key);
      if (held !== undefined) return Result.ok(held);
      // SAFETY: the booted driver is the one `options.driver` carried, whose dialect is D — or the SQLite default when none was given
      const typed = driver as SqlDriver & { readonly dialect?: D };
      const drizzleOptions = { engine, validate, driver: typed, schema };
      if (partition !== undefined) Object.assign(drizzleOptions, { partition });
      if (options.as !== undefined) Object.assign(drizzleOptions, { as: options.as });
      const handle = meshDrizzle<D>(drizzleOptions);
      handles.set(key, handle);
      return Result.ok(handle);
    });
  };
}

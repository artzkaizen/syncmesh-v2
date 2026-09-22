import type { Principal } from "@syncmesh/engine";
import type { InvalidPartitionKey, PartitionKey } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { ColumnsMap, PresenceMap, Schema } from "@syncmesh/schema";
import type { OperationStore, SqlDialect, SqlDriver } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { KeyRing } from "@syncmesh/wire";

import { meshDrizzle, type MeshHandle } from "@syncmesh/drizzle";
import { kindOf, parsePartitionKey } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";

import type { Booted } from "./boot.js";

import { PartitionSealed } from "./errors.js";

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
) => ResultType<Handle<D>, InvalidPartitionKey | PartitionSealed>;

/**
 * The handle cache: one Drizzle surface per `(instance, principal)` pair, built on first ask.
 *
 * The pair is the identity because it is exactly what the handle bakes in — the pin every write
 * is stamped with, and the actor every read is filtered for. Handing back the same object for
 * the same pair is what lets a caller compare handles, and what keeps a server that takes a
 * request per tenant from building a Drizzle instance per request.
 */
export interface HandleExtras {
  /** Threads into every handle's writer: the durable operation record per synced commit. */
  readonly operations?: OperationStore;
  readonly now?: () => Temporal.Instant;
  /**
   * Who this device's handles act as when the caller names nobody (book ch. 14). A server names
   * one per request; a device has one, and it comes from the session rather than a call site.
   */
  readonly sessionPrincipal?: () => Principal | undefined;
  /**
   * Whether this device can read a sealed partition's content (book ch. 14). Absent, nothing is
   * sealed here, which is every mesh that declares no sealed kind.
   */
  readonly canRead?: (partition: PartitionKey) => boolean;
}

/**
 * Whether this device can work in a partition at all (book ch. 14): every unsealed one, and the
 * sealed ones it holds a key for.
 *
 * Sealing is declared per *kind* and keys arrive per *instance*, because that is how each is
 * decided: a manifest says which kinds are end-to-end encrypted, and a grant says which wards of
 * the clinic this device was admitted to.
 */
export const readableWith =
  (schema: { readonly sealedKinds: ReadonlySet<string> }, keys: Pick<KeyRing, "keyFor">) =>
  (partition: PartitionKey): boolean =>
    !schema.sealedKinds.has(kindOf(partition)) || keys.keyFor(partition) !== undefined;

export function openHandles<C extends ColumnsMap, D extends SqlDialect, PC extends PresenceMap>(
  schema: Schema<C, PC>,
  booted: Booted,
  extras: HandleExtras = {},
): OpenHandle<D> {
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
      if (partition !== undefined && extras.canRead?.(partition) === false)
        return Result.err(
          new PartitionSealed({
            partition,
            message: `${partition} is sealed and this device holds no key for it: the key arrives inside a grant`,
          }),
        );
      const acting = options.as ?? extras.sessionPrincipal?.();
      const key = JSON.stringify([instance ?? null, acting ?? null]);
      const held = handles.get(key);
      if (held !== undefined) return Result.ok(held);
      // SAFETY: the booted driver is the one `options.driver` carried, whose dialect is D — or the SQLite default when none was given
      const typed = driver as SqlDriver & { readonly dialect?: D };
      const drizzleOptions = { engine, validate, driver: typed, schema };
      if (partition !== undefined) Object.assign(drizzleOptions, { partition });
      if (acting !== undefined) Object.assign(drizzleOptions, { as: acting });
      if (extras.operations !== undefined)
        Object.assign(drizzleOptions, { operations: extras.operations });
      if (extras.now !== undefined) Object.assign(drizzleOptions, { now: extras.now });
      const handle = meshDrizzle<D>(drizzleOptions);
      handles.set(key, handle);
      return Result.ok(handle);
    });
  };
}

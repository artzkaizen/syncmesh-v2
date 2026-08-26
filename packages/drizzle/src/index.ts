import type { Engine, Principal, Validator, ValidatorSchema } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
import type { SqlDialect, SqlDriver } from "@syncmesh/storage";

import { createWriter } from "@syncmesh/storage";
import { PgDialect } from "drizzle-orm/pg-core";

import type { FaceDeps } from "./face.js";

import { postgresFace } from "./postgres.js";
import { sqliteFace } from "./sqlite.js";

export type { Live, Runnable } from "./live.js";
export type { SqliteMeshDb } from "./sqlite.js";
export type { PostgresMeshDb } from "./postgres.js";

/**
 * Drizzle over a mesh (D20). The app reads and writes its tables with Drizzle; underneath, every
 * write statement is captured into one signed event, every read source carries the caller's
 * `read` rule, and a live query re-runs when a fold touches its tables. Drizzle executes through
 * its proxy driver over the mesh's own connection — SQLite on a device, Postgres on an
 * authority — so the app's statements run inside the capturing transaction, and there is one
 * ordering of transactions on it.
 */

export interface MeshDrizzleOptions<D extends SqlDialect = "sqlite"> {
  readonly engine: Engine;
  readonly validate: Validator;
  /** The connection the tables live on, with capture installed (`openStores` does both). Its dialect picks the face. */
  readonly driver: SqlDriver & { readonly dialect?: D };
  /** The manifest: which tables sync, their rules, the role ladders. */
  readonly schema: ValidatorSchema;
  /** The instance every write runs under and every read is confined to. */
  readonly partition?: PartitionKey;
  /**
   * Act as this principal: `read()` sources admit only rows their `read` rule admits, and a
   * write their rules deny is refused before COMMIT. The events stay the device's.
   */
  readonly as?: Principal;
}

/** The handle a dialect hands out: `db`, `read` and `live` over that dialect's Drizzle. */
export type MeshHandle<D extends SqlDialect = "sqlite"> = D extends "postgres"
  ? ReturnType<typeof postgresFace>
  : ReturnType<typeof sqliteFace>;

/** `MeshHandle["db"]` under its SQLite-era name. */
export type MeshDb = MeshHandle["db"];

export function meshDrizzle<D extends SqlDialect = "sqlite">(
  options: MeshDrizzleOptions<D>,
): MeshHandle<D> {
  const { engine, validate, driver, schema, partition, as: actor } = options;
  const tables = schema.entries.map((e) => e.table);
  const writerDeps = { engine, validate, driver, tables, schema };
  if (actor !== undefined) Object.assign(writerDeps, { actor });
  const deps: FaceDeps = {
    engine,
    schema,
    driver,
    writer: createWriter(writerDeps),
    pgDialect: () => new PgDialect(),
  };
  if (partition !== undefined) Object.assign(deps, { partition });
  if (actor !== undefined) Object.assign(deps, { actor });
  // SAFETY: the driver's dialect is D; each face is the D-typed handle
  return (driver.dialect === "postgres" ? postgresFace(deps) : sqliteFace(deps)) as MeshHandle<D>;
}

/**
 * The mesh's tagged error inside a rejected statement or transaction — Drizzle wraps proxy
 * failures, so `PolicyDenied` and friends ride the `cause` chain. `undefined` for anything else.
 */
export const taggedCause = (thrown: Error): (Error & { readonly _tag: string }) | undefined => {
  let current: unknown = thrown;
  while (current instanceof Error) {
    // SAFETY: reading an optional discriminant off an Error; absent on plain errors, the walk continues
    const tagged = current as Error & { readonly _tag?: string };
    if (tagged._tag !== undefined) {
      // SAFETY: _tag was just checked present — restated as required for the caller
      return tagged as Error & { readonly _tag: string };
    }
    current = current.cause;
  }
  return undefined;
};

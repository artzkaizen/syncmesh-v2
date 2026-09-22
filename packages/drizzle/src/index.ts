import type { Engine, Principal, Validator, ValidatorSchema } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
import type { OperationStore, SqlDialect, SqlDriver } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";

import { syncedTables } from "@syncmesh/schema";
import { createWriter } from "@syncmesh/storage";
import { PgDialect } from "drizzle-orm/pg-core";

import type { FaceDeps } from "./face.js";

import { postgresFace } from "./postgres.js";
import { sqliteFace } from "./sqlite.js";

export type { Live, LiveListener, LiveQuery, LiveSnapshot, LiveSource, Runnable } from "./live.js";
export { createLive } from "./live.js";
export type { LiveChange, Patched } from "./patch.js";
export { patchWindow } from "./patch.js";
export type { LiveWindow } from "./window.js";
export { windowOf } from "./window.js";
export { compareCells } from "./order.js";
export { identityOf, tablesOf } from "./tree.js";
export type { ProxyMethod, ProxyResult, ProxySink, WriteNaming } from "./proxy.js";
export type { ReadScope } from "./read.js";
export { readPredicate, readScope } from "./read.js";
export type { ReadOnlyDb } from "./scoped.js";
export { readOnly, scopeReads } from "./scoped.js";
export type { SyncState } from "./sync-of.js";
export { ROW_SYNC_TABLE, columns, operationOf, syncOf } from "./sync-of.js";
export { replaceEqualDeep } from "./equal.js";
export type { CommitHub, Span } from "./face.js";
export type { SqliteMeshDb } from "./sqlite.js";
export type { PostgresMeshDb } from "./postgres.js";

/**
 * Drizzle over a mesh (D20). The app reads and writes its tables with Drizzle; underneath, every
 * write statement is captured into one signed event, every read source carries the caller's
 * `read` rule, and a live query re-runs when a fold touches its tables. Drizzle executes through
 * its proxy driver over the mesh's own connection — SQLite on a device, Postgres on an
 * authority — so the app's statements run inside the capturing transaction, and there is one
 * ordering of transactions on it.
 *
 * The rule this rests on: a table is defined once in your Drizzle schema, synced through the
 * mesh, and materialised into that same table. Never write a synced table with raw SQL on the
 * server — a write that does not pass through a handle is invisible to capture, becomes no
 * event, and diverges from every peer.
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
  /** Writes each synced commit's durable operation record inside the transaction (book ch. 10). */
  readonly operations?: OperationStore;
  readonly now?: () => Temporal.Instant;
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
  const tables = syncedTables(schema);
  const writerDeps = { engine, validate, driver, tables, schema };
  if (actor !== undefined) Object.assign(writerDeps, { actor });
  if (options.operations !== undefined)
    Object.assign(writerDeps, { operations: options.operations });
  if (options.now !== undefined) Object.assign(writerDeps, { now: options.now });
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

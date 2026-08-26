import type { Engine, Principal, ValidatorSchema } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
import type { SqlDriver, Write } from "@syncmesh/storage";
import type { PgDialect } from "drizzle-orm/pg-core";

/** What both faces build on: the mesh's writer over the capturing connection, and the read scope. */
export interface FaceDeps {
  readonly engine: Engine;
  readonly schema: ValidatorSchema;
  readonly driver: SqlDriver;
  readonly writer: Write;
  readonly partition?: PartitionKey;
  readonly actor?: Principal;
  /** Drizzle's Postgres dialect, constructed by the caller so the SQLite face never loads pg-core. */
  readonly pgDialect: () => PgDialect;
}

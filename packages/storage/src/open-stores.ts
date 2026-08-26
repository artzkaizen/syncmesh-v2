import type { EventStore, StateStore, StoreFailure } from "@syncmesh/engine";
import type { Table } from "@syncmesh/schema";

import { Result } from "@syncmesh/result";

import type { SqlDriver } from "./driver.js";
import type { ProjectionOptions } from "./projection.js";

import { installCapture } from "./capture.js";
import { sqlEventStore } from "./event-store.js";
import { tablesProjection } from "./projection.js";
import { sqlStateStore } from "./state-store.js";

/** The event log and the persisted state over one database, closed together. */
export interface Stores {
  readonly events: EventStore;
  readonly state: StateStore;
  /** The connection everything shares — what a query layer runs over. */
  readonly driver: SqlDriver;
  readonly close: () => Promise<void>;
}

export interface OpenStoresOptions extends ProjectionOptions {
  /**
   * The synced tables to hold as real SQL tables in the same database (D20), written by every
   * fold. On SQLite they are created on open with change capture installed; on Postgres they are
   * yours — defined once in your ORM, migrated by you — and only the projection is added.
   * Absent, state lives only in the sidecar.
   */
  readonly tables?: readonly Table[];
}

export function openStores(
  driver: SqlDriver,
  options: OpenStoresOptions = {},
): Promise<Result<Stores, StoreFailure>> {
  return Result.gen(async function* () {
    const events = yield* Result.await(sqlEventStore(driver));
    const stateOptions = {};
    if (options.tables !== undefined) {
      if (driver.dialect !== "postgres")
        yield* Result.await(installCapture(driver, options.tables));
      const projectionOptions =
        options.partitionColumn === undefined ? {} : { partitionColumn: options.partitionColumn };
      Object.assign(stateOptions, {
        projection: tablesProjection(driver, options.tables, projectionOptions),
      });
    }
    const state = yield* Result.await(sqlStateStore(driver, stateOptions));
    return Result.ok({ events, state, driver, close: () => driver.close?.() ?? Promise.resolve() });
  });
}

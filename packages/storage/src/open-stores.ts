import type { EventStore, StateStore, StoreFailure } from "@syncmesh/engine";
import type { Table } from "@syncmesh/schema";

import { Result } from "@syncmesh/result";

import type { SqliteDriver } from "./driver.js";

import { installCapture } from "./capture.js";
import { tablesProjection } from "./projection.js";
import { sqliteEventStore } from "./sqlite-event-store.js";
import { sqliteStateStore } from "./sqlite-state-store.js";

/** The event log and the persisted state over one database, closed together. */
export interface Stores {
  readonly events: EventStore;
  readonly state: StateStore;
  /** The connection everything shares — what a query layer runs over. */
  readonly driver: SqliteDriver;
  readonly close: () => Promise<void>;
}

export interface OpenStoresOptions {
  /**
   * The synced tables to hold as real SQL tables in the same database (D20): created on open with
   * change capture installed, and written by every fold. Absent, state lives only in the sidecar.
   */
  readonly tables?: readonly Table[];
}

export function openStores(
  driver: SqliteDriver,
  options: OpenStoresOptions = {},
): Promise<Result<Stores, StoreFailure>> {
  return Result.gen(async function* () {
    const events = yield* Result.await(sqliteEventStore(driver));
    const stateOptions = {};
    if (options.tables !== undefined) {
      yield* Result.await(installCapture(driver, options.tables));
      Object.assign(stateOptions, { projection: tablesProjection(driver, options.tables) });
    }
    const state = yield* Result.await(sqliteStateStore(driver, stateOptions));
    return Result.ok({ events, state, driver, close: () => driver.close?.() ?? Promise.resolve() });
  });
}

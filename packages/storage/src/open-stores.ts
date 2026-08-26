import type { EventStore, StateStore, StoreFailure } from "@syncmesh/engine";
import type { Table } from "@syncmesh/schema";

import { Result } from "@syncmesh/result";

import type { SqlDriver } from "./driver.js";
import type { ProjectionOptions } from "./projection.js";

import { installCapture } from "./capture.js";
import { sqlEventStore } from "./event-store.js";
import { tablesProjection } from "./projection.js";
import { inTransaction } from "./sql.js";
import { sqlStateStore } from "./state-store.js";

/** The log and the state as one transaction sees them: what `Stores.atomic` hands its callback. */
export interface ScopedStores {
  readonly events: EventStore;
  readonly state: StateStore;
}

/** The event log and the persisted state over one database, closed together. */
export interface Stores extends ScopedStores {
  /** The connection everything shares — what a query layer runs over. */
  readonly driver: SqlDriver;
  /**
   * Runs `fn` in one transaction on the connection, with stores that write into it rather than
   * opening their own: an event appended and its rows materialised land together or not at all —
   * the crash window the cursor sidecar would otherwise have to recover. What the engine's
   * `atomic` option takes.
   */
  readonly atomic: <T>(fn: (scoped: ScopedStores) => Promise<T>) => Promise<T>;
  readonly close: () => Promise<void>;
}

export interface OpenStoresOptions extends ProjectionOptions {
  /**
   * The synced tables to hold as real SQL tables in the same database (D20), written by every
   * fold, with change capture installed. Created on open where they do not exist; on Postgres
   * they are usually yours already — defined once in your ORM, migrated by you — and only the
   * triggers are added. Absent, state lives only in the sidecar.
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
      yield* Result.await(installCapture(driver, options.tables));
      const projectionOptions =
        options.partitionColumn === undefined ? {} : { partitionColumn: options.partitionColumn };
      Object.assign(stateOptions, {
        projection: tablesProjection(driver, options.tables, projectionOptions),
      });
    }
    const state = yield* Result.await(sqlStateStore(driver, stateOptions));
    const scoped: ScopedStores = {
      events: yield* Result.await(sqlEventStore(driver, { nested: true })),
      state: yield* Result.await(sqlStateStore(driver, { ...stateOptions, nested: true })),
    };
    const atomic: Stores["atomic"] = (fn) => inTransaction(driver, () => fn(scoped));
    return Result.ok({
      events,
      state,
      driver,
      atomic,
      close: () => driver.close?.() ?? Promise.resolve(),
    });
  });
}

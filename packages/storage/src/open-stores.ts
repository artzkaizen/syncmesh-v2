import type { EventStore, StateStore, StoreFailure } from "@syncmesh/engine";

import { Result } from "@syncmesh/result";

import type { SqliteDriver } from "./driver.js";

import { sqliteEventStore } from "./sqlite-event-store.js";
import { sqliteStateStore } from "./sqlite-state-store.js";

/** The event log and the persisted state over one database, closed together. */
export interface Stores {
  readonly events: EventStore;
  readonly state: StateStore;
  readonly close: () => Promise<void>;
}

export function openStores(driver: SqliteDriver): Promise<Result<Stores, StoreFailure>> {
  return Result.gen(async function* () {
    const events = yield* Result.await(sqliteEventStore(driver));
    const state = yield* Result.await(sqliteStateStore(driver));
    return Result.ok({ events, state, close: () => driver.close?.() ?? Promise.resolve() });
  });
}

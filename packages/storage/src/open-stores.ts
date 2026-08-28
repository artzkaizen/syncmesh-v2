import type { EventStore, StateStore, StoreFailure } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
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

/**
 * Where one slice of a device's data lives (D07): a top-level partition instance with its own
 * database, or `"user"` for the account's own. The unit a device *forgets* — leaving an org
 * deletes one file, so nothing of any other org can be in it and nothing of this one may be
 * anywhere else.
 */
export type StoreScope = PartitionKey | "user";

/**
 * The name a scope's database takes, and the room a transport qualifies with it. One function so
 * the file and the room can never drift apart, and `kind-id` rather than `kind:id` because a
 * colon is not a filename everywhere. Injective: a kind holds no `-`, so the first one is always
 * the separator, and `"user"` holds none at all.
 */
export const storeNameFor = (scope: StoreScope): string => {
  if (scope === "user") return "user";
  const at = scope.indexOf(":");
  return `${scope.slice(0, at)}-${encodeURIComponent(scope.slice(at + 1))}`;
};

export interface ScopedStoresOptions extends OpenStoresOptions {
  /**
   * Opens the connection one scope's data lives on, given the scope and the name it takes. Called
   * once per scope: the caller decides where a database is, because only it knows the platform.
   */
  readonly driverFor: (scope: StoreScope, name: string) => SqlDriver | Promise<SqlDriver>;
}

/** One engine's worth of storage per scope, opened on demand and closed one at a time. */
export interface ScopedStoreSet {
  /** This scope's stores, opened once and shared; two callers racing get the same one. */
  readonly storeFor: (scope: StoreScope) => Promise<Result<Stores, StoreFailure>>;
  /** The scopes this set currently holds open, in the order they were opened. */
  readonly opened: () => readonly StoreScope[];
  /**
   * Closes one scope's stores and forgets them, leaving every other open. What leaving an org
   * runs before its file is deleted — the deletion itself belongs to whoever knew where to put
   * it, which is the same caller that opened the driver.
   */
  readonly forget: (scope: StoreScope) => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Stores keyed by scope, so a cross-tenant read cannot be expressed: there is no query that
 * spans two, because there is no connection that holds both. The exploration kept every org in
 * one log and could only *filter*, which meant a filter bug was a tenancy bug.
 */
export function scopedStores(options: ScopedStoresOptions): ScopedStoreSet {
  const { driverFor, ...storeOptions } = options;
  const held = new Map<StoreScope, Promise<Result<Stores, StoreFailure>>>();

  const open = async (scope: StoreScope): Promise<Result<Stores, StoreFailure>> => {
    const driver = await driverFor(scope, storeNameFor(scope));
    return openStores(driver, storeOptions);
  };

  return {
    storeFor: (scope) => {
      const current = held.get(scope);
      if (current !== undefined) return current;
      // a failed open is not remembered: the next call gets a fresh attempt rather than a
      // cached error that outlives whatever caused it
      const opening = open(scope).then((result) => {
        if (result.isErr()) held.delete(scope);
        return result;
      });
      held.set(scope, opening);
      return opening;
    },
    opened: () => [...held.keys()],
    forget: async (scope) => {
      const current = held.get(scope);
      held.delete(scope);
      const stores = await current;
      if (stores?.isOk()) await stores.value.close();
    },
    close: async () => {
      const all = [...held.values()];
      held.clear();
      for (const opening of all) {
        const stores = await opening;
        if (stores.isOk()) await stores.value.close();
      }
    },
  };
}

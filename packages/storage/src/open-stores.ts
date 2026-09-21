import type { EventStore, StateStore } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
import type { Table } from "@syncmesh/schema";

import { StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";

import type { SqlDriver } from "./driver.js";
import type { ProjectionOptions } from "./projection.js";

import { captureDdlFor, installCapture } from "./capture.js";
import { ATTACHED_LOG, dialectOf } from "./dialect.js";
import { sqlEventStore } from "./event-store.js";
import { tablesProjection } from "./projection.js";
import { rowSyncDdlFor, rowSyncTable, type RowSync } from "./row-sync.js";
import { attempt, inTransaction } from "./sql.js";
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
  /** Where each row's own write got to, for `syncOf` (book ch. 10); absent with no tables. */
  readonly rowSync?: RowSync;
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

/**
 * The app's tables and their capture, installed **only when this database has not got them.**
 *
 * Every statement here is `IF NOT EXISTS`, so running them all on every launch was correct and
 * quietly wasteful: forty-odd statements to parse, per open, to discover there was nothing to do.
 * What replaces that is one read of one row. The row holds the exact DDL last installed, so
 * "unchanged" is string equality rather than a version somebody has to remember to bump — add a
 * column, add a table, change a dialect, and the text differs and everything is reinstalled.
 *
 * The one thing it cannot see is a change made *around* it: drop a trigger by hand and this will
 * still say the schema is installed. That is the same bargain every migration table makes, and
 * the repair is the same — clear the row, or the file.
 */
const installed = (
  driver: SqlDriver,
  tables: readonly Table[],
): Promise<Result<void, StoreFailure>> => {
  const { schema, name: dialect } = dialectOf(driver);
  const rowSyncDdl = rowSyncDdlFor(dialect);
  const wanted = [...captureDdlFor(driver, tables), ...rowSyncDdl].join(";\n");
  return attempt("the app schema failed to install", async () => {
    await driver.run(schema.ddl);
    const [held] = await driver.all(schema.read);
    if (held?.[0] === wanted) return;
    await installCapture(driver, tables).then((done) => done.unwrap());
    for (const statement of rowSyncDdl) await driver.run(statement);
    await driver.run(schema.write, [wanted]);
  });
};

/**
 * Attaches the log file under the name its tables are written against.
 *
 * **The connection's owner does this, not `openStores`**, because the paths are the opener's:
 * an adapter knows where its files go, a test knows it wants two in memory, and a driver handed
 * in from outside may have been opened by somebody with their own arrangement. What `openStores`
 * does is refuse to proceed without it, so a missing attach fails at the open rather than at the
 * first query against a table that does not resolve.
 *
 * `:memory:` is a real answer here — it gives a second, private in-memory database — and is what
 * a test wants when it is not testing durability.
 */
/**
 * Where one store's log lives, given where its derived half does.
 *
 * **A store is two files now, and this is the only place that says so.** Everything that treats
 * a scope as a unit has to agree: the opener attaches both, and whoever forgets a scope deletes
 * both. `StoreScope` exists so that leaving an org is a file deletion and nothing of another org
 * can be caught in it — and a caller that deleted only the first would leave the log behind, with
 * every event still in it, to be found again on the next join.
 */
export const logPathFor = (statePath: string): string => `${statePath}.log`;

/**
 * The sidecar the store's lock is held on — a third file, and deliberately not either half.
 *
 * A lock taken on one of the data files would be a transaction held open against it for the life
 * of the process, which is the thing WAL exists to avoid. So the hold is on a file with nothing
 * in it, and what it guards is the **store** — every path in {@link storeFilesFor}, opened,
 * rebuilt, migrated or deleted only by whoever holds it.
 */
export const lockPathFor = (statePath: string): string => `${statePath}.lock`;

/** Both files of one store, for a caller that has to delete or copy the set. */
export const storeFilesFor = (statePath: string): readonly string[] => [
  statePath,
  logPathFor(statePath),
];

export const attachLog = (driver: SqlDriver, path: string): Promise<void> =>
  driver.run(`ATTACH DATABASE ? AS ${ATTACHED_LOG}`, [path]);

/**
 * Whether this connection has the log attached; `openStores` will not open a store without it.
 *
 * Through `attempt`, because a driver that cannot answer is a store failure like any other — a
 * bare `await` here would throw out of the `Result.gen` below and surface as a panic instead of
 * the reason the disk gave.
 */
const logAttached = (driver: SqlDriver): Promise<Result<boolean, StoreFailure>> =>
  attempt("could not read the attached databases", async () =>
    (await driver.all("PRAGMA database_list")).some((row) => String(row[1]) === ATTACHED_LOG),
  );

export function openStores(
  driver: SqlDriver,
  options: OpenStoresOptions = {},
): Promise<Result<Stores, StoreFailure>> {
  return Result.gen(async function* () {
    if (driver.dialect !== "postgres" && !(yield* Result.await(logAttached(driver)))) {
      return Result.err(
        new StoreFailure({
          message: `the log is not attached as \`${ATTACHED_LOG}\` — call attachLog(driver, path) on this connection first`,
        }),
      );
    }
    const events = yield* Result.await(sqlEventStore(driver));
    const stateOptions = {};
    let rowSync: RowSync | undefined;
    if (options.tables !== undefined) {
      yield* Result.await(installed(driver, options.tables));
      rowSync = rowSyncTable(driver);
      const projectionOptions = { rowSync };
      if (options.partitionColumn !== undefined)
        Object.assign(projectionOptions, { partitionColumn: options.partitionColumn });
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
    const opened = {
      events,
      state,
      driver,
      atomic,
      close: () => driver.close?.() ?? Promise.resolve(),
    };
    return Result.ok(rowSync === undefined ? opened : { ...opened, rowSync });
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

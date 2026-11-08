import type { DocStore, EventStore, StateStore } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
import type { Table } from "@syncmesh/schema";

import { sha256 } from "@noble/hashes/sha2.js";
import { StoreFailure, refoldable } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { bytesToHex } from "@syncmesh/wire";

import type { SqlDialect, SqlDriver } from "./driver.js";
import type { ProjectionOptions } from "./projection.js";

import { captureStatements, installCapture } from "./capture.js";
import { ATTACHED_LOG, driverDialect, logPlacement } from "./dialect.js";
import { sqlDocStore } from "./doc-store.js";
import { sqlEventStore } from "./event-store.js";
import { closeSession, openSession } from "./integrity.js";
import { journalPosition, journalingDriver, recoverJournal } from "./journal.js";
import { tablesProjection } from "./projection.js";
import { rowSyncDdlFor, rowSyncTable, type RowSync } from "./row-sync.js";
import { attempt, inTransaction } from "./sql.js";
import { sqlStateStore } from "./state-store.js";

/** The log, the state and the doc log as one transaction sees them: what `Stores.atomic` hands its callback. */
export interface ScopedStores {
  readonly events: EventStore;
  readonly state: StateStore;
  /** The doc log and heads (RFC-0023 §6.2): appended in the same transaction as the events they index. */
  readonly docs: DocStore;
}

/** The event log and the persisted state over one database, closed together. */
export interface Stores extends ScopedStores {
  /**
   * The connection everything shares — what a query layer and a writer run over. On a device's
   * SQLite it journals every transaction that writes both files (RFC-0022), so a write through it
   * survives a crash between their commits; one through the driver you passed in does not.
   */
  readonly driver: SqlDriver;
  /**
   * Runs `fn` in one transaction on the connection, with stores that write into it rather than
   * opening their own: an event appended and its rows materialised land together or not at all.
   * Across the two files of a device's SQLite that holds through a crash because the transaction
   * is journaled and the open replays a log half that did not land. What the engine's `atomic`
   * option takes.
   */
  readonly atomic: <T>(fn: (scoped: ScopedStores) => Promise<T>) => Promise<T>;
  /** Where each row's own write got to, for `syncOf` (book ch. 10); absent with no tables. */
  readonly rowSync?: RowSync;
  /**
   * Records that this session over the log ended cleanly, without closing the connection: what a
   * caller that owns the driver runs where `close` would close what is not its own. A session that
   * ends without it is checked page by page at the next open (D39).
   */
  readonly markClean: () => Promise<void>;
  /** {@link Stores.markClean}, then closes the connection. */
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
 * A short, stable name for one shape of the app's schema.
 *
 * It names the **state file**: change a column and the name changes, so the fold opens an empty
 * file and rebuilds it from the log rather than migrating the old one in place (RFC-0022). That
 * only works while `refoldable` is true — a device that has compacted holds rows the log can no
 * longer produce, and for it the old file is not an orphan but the only copy.
 *
 * Derived from the DDL the tables actually produce rather than from the manifest object, because
 * the DDL is what the file contains. Twelve hex characters: this distinguishes a handful of
 * shapes on one device over its life, not a corpus.
 */
export const schemaName = (tables: readonly Table[], dialect: SqlDialect = "sqlite"): string =>
  bytesToHex(
    sha256(new TextEncoder().encode(captureStatements({ dialect }, tables).join(";"))),
  ).slice(0, 12);

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
 *
 * **A changed schema is only free while the log can still produce the rows.** The row it compares
 * lives in the log, which is shared; the file it is comparing against is the derived half, which
 * `schemaName` gives a different name to for every shape. So changing a column normally opens
 * an empty file and refolds into it, and the previous shape's file is an orphan nobody reads.
 * Once the log has been compacted that stops being true — the old file holds rows no fold can
 * produce again — and the open refuses rather than silently presenting an empty database.
 */
const installed = (
  driver: SqlDriver,
  tables: readonly Table[],
  events: EventStore,
): Promise<Result<void, StoreFailure>> =>
  Result.gen(async function* () {
    const { schema, name: dialect } = driverDialect(driver);
    const rowSyncDdl = rowSyncDdlFor(dialect);
    const wanted = [...captureStatements(driver, tables), ...rowSyncDdl].join(";\n");
    const held = yield* Result.await(
      attempt("could not read the installed schema", async () => {
        await driver.run(schema.ddl);
        const [row] = await driver.all(schema.read);
        return row?.[0];
      }),
    );
    if (held === wanted) return Result.ok(undefined);
    if (held !== undefined && !(yield* Result.await(refoldable(events)))) {
      return Result.err(
        new StoreFailure({
          message:
            "the app's tables changed shape and this log has been compacted — the rows below the floor exist only in the state file the previous shape wrote, so there is nothing left to refold them from. Keep the previous schema, or rejoin from a peer.",
        }),
      );
    }
    yield* Result.await(
      attempt("the app schema failed to install", async () => {
        await installCapture(driver, tables).then((done) => done.unwrap());
        for (const statement of rowSyncDdl) await driver.run(statement);
        await driver.run(schema.write, [wanted]);
      }),
    );
    return Result.ok(undefined);
  });

/**
 * A store's files, all derived from one stable name: **the log's**.
 *
 * The log is the base because it is the half that cannot be replaced, and because the derived
 * half's filename carries a hash of the app's schema (RFC-0022) — so it changes, and a name that
 * changed could not be the thing everything else is named after. "Back up `<name>.db`" stays true
 * for the life of the store.
 *
 * A store is three files: the log, one state file per schema the log has been folded under, and a
 * lock sidecar. The sidecar is a third file rather than a hold on either half, because a lock
 * taken on data is a transaction held open against it for the life of the process, which is what
 * WAL exists to avoid.
 */
export const statePath = (logPath: string, schema: string): string => `${logPath}.state@${schema}`;

/** The hold is over the **store** — every file below — and only one opener may have it. */
export const lockPath = (logPath: string): string => `${logPath}.lock`;

/**
 * Both halves, for a caller that has to delete or copy the set.
 *
 * `StoreScope` exists so that leaving an org is a file deletion and nothing of another org can be
 * caught in it. With more than one file that is more than one deletion, and a caller that forgot
 * the log would leave every event in it to be found again on the next join — which a test caught
 * doing exactly that.
 */
export const storeFiles = (logPath: string, schema: string): readonly string[] => [
  logPath,
  statePath(logPath, schema),
];

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
  connection: SqlDriver,
  options: OpenStoresOptions = {},
): Promise<Result<Stores, StoreFailure>> {
  return Result.gen(async function* () {
    // an inline driver was never going to attach anything — its runtime has no `ATTACH` — so the
    // guard would be refusing the one arrangement that is correct there (RFC-0022)
    if (
      logPlacement(connection) === "attached" &&
      connection.dialect !== "postgres" &&
      !(yield* Result.await(logAttached(connection)))
    ) {
      return Result.err(
        new StoreFailure({
          message: `the log is not attached as \`${ATTACHED_LOG}\` — call attachLog(driver, path) on this connection first`,
        }),
      );
    }
    // both ladders, and then before anything reads either file: a write whose state committed
    // and whose log entry did not is finished here, so no reader sees a cursor past the log
    // (RFC-0022)
    yield* Result.await(sqlEventStore(connection));
    yield* Result.await(recoverJournal(connection));
    const driver = journalingDriver(connection, yield* Result.await(journalPosition(connection)));
    const events = yield* Result.await(sqlEventStore(driver));
    // once, and only after a session that never reached `close`: a torn page a read cannot see
    // is refused here rather than folded around (D39)
    yield* Result.await(openSession(driver));
    const stateOptions = {};
    let rowSync: RowSync | undefined;
    if (options.tables !== undefined) {
      yield* Result.await(installed(driver, options.tables, events));
      rowSync = rowSyncTable(driver);
      const projectionOptions = { rowSync };
      if (options.partitionColumn !== undefined)
        Object.assign(projectionOptions, { partitionColumn: options.partitionColumn });
      Object.assign(stateOptions, {
        projection: tablesProjection(driver, options.tables, projectionOptions),
      });
    }
    const state = yield* Result.await(sqlStateStore(driver, stateOptions));
    const docs = yield* Result.await(sqlDocStore(driver));
    const scoped: ScopedStores = {
      events: yield* Result.await(sqlEventStore(driver, { nested: true })),
      state: yield* Result.await(sqlStateStore(driver, { ...stateOptions, nested: true })),
      docs: yield* Result.await(sqlDocStore(driver, { nested: true })),
    };
    const atomic: Stores["atomic"] = (fn) => inTransaction(driver, () => fn(scoped));
    // a mark that does not land costs one check at the next open, which is the safe direction —
    // so it is said, not thrown, and the connection still closes
    const markClean = async () => {
      const marked = await closeSession(driver);
      if (marked.isErr()) console.warn(`[syncmesh] ${marked.error.message}`);
    };
    const opened = {
      events,
      state,
      docs,
      driver,
      atomic,
      markClean,
      close: async () => {
        await markClean();
        await driver.close?.();
      },
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
export const storeName = (scope: StoreScope): string => {
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
    const driver = await driverFor(scope, storeName(scope));
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

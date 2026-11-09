import type {
  Engine,
  EngineError,
  EngineOptions,
  EventStore,
  StateCorrupt,
  StateStore,
  StoreFailure,
  Validator,
  ValidatorOptions,
} from "@syncmesh/engine";
import type { DocColumns, MergeSpec, PeerId, SchemaVersion, TableName } from "@syncmesh/kernel";
import type { DocColumnEntry, Table } from "@syncmesh/schema";
import type {
  OpenStoresOptions,
  OperationStore,
  RowSync,
  SqlDriver,
  StoreLocked,
  Stores,
  StrictCapture,
} from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { Grant, Identity } from "@syncmesh/wire";

import { createValidator, openEngine } from "@syncmesh/engine";
import { DEFAULT_MAX_DRIFT, createHlcClock, parseAdapterId } from "@syncmesh/kernel";
import { Result, omitUndefined, panic } from "@syncmesh/result";
import { syncedTables } from "@syncmesh/schema";
import { installRls, openStores, operationStore } from "@syncmesh/storage";

import { NoDefaultStore } from "./errors.js";
import { deviceIncarnation } from "./identity.js";

export type MeshOpenError = StoreFailure | StateCorrupt | NoDefaultStore | StoreLocked;

export interface BootOptions {
  /**
   * What boot reads off the manifest: the validator's structural view, the merge rules, and the
   * document columns the validator and the fold both judge a doc change by (RFC-0023 §4.1).
   */
  readonly schema: ValidatorOptions["schema"] & {
    readonly merge: MergeSpec;
    readonly docs?: ReadonlyMap<TableName, readonly DocColumnEntry[]>;
    /** What the manifest declared (D31): stamped on every event and cursors frame. */
    readonly schemaVersion?: SchemaVersion;
  };
  readonly identity: Identity;
  readonly issuer?: PeerId;
  readonly authority?: PeerId;
  readonly undoDepth?: number;
  readonly store?: EventStore;
  readonly stateStore?: StateStore;
  /** Your own SQLite connection: tables and capture are installed on it and it becomes the log too. */
  readonly driver?: SqlDriver;
  /**
   * Stores already opened by someone else — what `scopedStores().storeFor(scope)` hands back, and
   * how a device runs one engine per top-level instance over one database each (D07).
   *
   * They stay the caller's to close, which is the point: leaving an org is `forget(scope)` and
   * deleting one file, and a mesh that closed them on `stop()` would take the set's bookkeeping
   * with it.
   */
  readonly stores?: Stores;
  readonly dataDir: string;
  /** Refuse a write to a synced table outside a captured transaction (gaps U5); default `true`. */
  readonly strict?: StrictCapture;
  /** Install RLS from the read rules on boot; postgres drivers only. */
  readonly rls?: boolean;
  readonly now: () => Temporal.Instant;
  /**
   * The most a peer's stamp may lead `now()` and still be folded (D34); default
   * {@link DEFAULT_MAX_DRIFT}. One bound for two seams — the clock clamps a remote stamp to it,
   * the ladder parks an event beyond it — so a device never adopts a stamp it would not fold.
   */
  readonly clockDrift?: Temporal.Duration;
  /**
   * Threaded straight to {@link EngineOptions.onError}, which is the only reason it is on the
   * options rather than a subscription taken afterwards: the stranded-writes audit runs *inside*
   * `openEngine`, and a caller cannot subscribe to a call that has not returned.
   */
  readonly onError?: (error: EngineError) => void;
  readonly grantFor: (peer: PeerId) => Grant | undefined;
  /** Shipped config, threaded straight through: whether the ladder reads `_links` (D21). */
  readonly accounts?: boolean;
}

/** A booted engine, the log it runs on, its validator, and how to let go of what was opened for it; a store you passed in stays yours. */
export interface Booted {
  readonly engine: Engine;
  readonly store: EventStore;
  /** The SQL connection the tables live on; absent for a mesh over a bare event store. */
  readonly driver?: SqlDriver;
  /** The write ledger's store, on that same connection; present exactly when `driver` is. */
  readonly operations?: OperationStore;
  /**
   * This store's lineage, minted into it on the first boot (D28) — what this device's custody
   * receipts sign over. Present exactly when `driver` is: a mesh over a bare event store has no
   * file to name, so it signs for nothing and says so by having nothing to say.
   */
  readonly incarnation?: string;
  /** Where each row's own write got to (book ch. 10); present when the stores hold tables. */
  readonly rowSync?: RowSync;
  /** The same ladder the engine runs on every write — for judging a captured transaction before it commits (D20). */
  readonly validate: Validator;
  /**
   * The session over the log, marked clean and open again around a time the process may be killed
   * without reaching `close` — an app in the background (D39). Present exactly when the mesh marks
   * the session at `close`: over your driver or the default store, never over stores you opened.
   */
  readonly session?: SessionMarks;
  readonly close: () => Promise<void>;
}

/** Marking the session over a device's log ended cleanly, and open again (D39). */
export interface SessionMarks {
  readonly clean: () => Promise<void>;
  readonly open: () => Promise<void>;
}

/**
 * The durable store this platform has — one SQLite file per identity under `dir` — or
 * `NoDefaultStore` where there is none yet: pass `storage: sqlite({ store })` there, memory included.
 */
async function defaultStores(
  dir: string,
  name: string,
  opened: OpenStoresOptions,
): Promise<Result<Stores, MeshOpenError>> {
  if ("Bun" in globalThis) {
    const { defaultStore } = await import("@syncmesh/sqlite-bun");
    return defaultStore({ name, dir, ...opened });
  }
  if ("process" in globalThis) {
    const { defaultStore } = await import("@syncmesh/sqlite-node");
    return defaultStore({ name, dir, ...opened });
  }
  return Result.err(
    new NoDefaultStore({
      message:
        "no durable store on this platform yet (E04): pass `storage: sqlite({ store })` — `createMemoryEventStore()` to opt into memory",
    }),
  );
}

/**
 * The manifest's document columns keyed the way the kernel keys them: per table, each column and
 * its adapter. Absent when the schema declares none.
 */
function docColumns(schema: BootOptions["schema"]): DocColumns | undefined {
  if (schema.docs === undefined || schema.docs.size === 0) return undefined;
  return new Map(
    [...schema.docs].map(([table, entries]) => [
      table,
      new Map(
        entries.map((entry) => [
          entry.column,
          // the schema's checkMerge already refused any id the kernel's rule refuses
          parseAdapterId(entry.doc).unwrap(),
        ]),
      ),
    ]),
  );
}

/** The validator an identity runs: grants when an issuer is configured, authorship when this process is the authority. */
function validatorSettings(options: BootOptions, docs: DocColumns | undefined): ValidatorOptions {
  const { schema, issuer, authority, grantFor, now } = options;
  const validatorOptions = {
    schema,
    grantFor: issuer === undefined ? null : grantFor,
    // being the authority is authorship, not a flag: this process is it when the named peer is us
    // arms the grace rung, and answers for a local write that has no stamp yet; an event
    // arriving from a peer carries its own, so both sides read it the same way
    now,
    // the same bound the clock clamps to (D34): what this device will not adopt, it does not fold
    maxDrift: options.clockDrift ?? DEFAULT_MAX_DRIFT,
  } satisfies ValidatorOptions;
  if (authority !== undefined) Object.assign(validatorOptions, { authority });
  if (options.accounts === true) Object.assign(validatorOptions, { accounts: true });
  if (docs !== undefined) Object.assign(validatorOptions, { docs });
  return validatorOptions;
}

/** `rls: true` compiles the read rules into the database's own policies — Postgres only. */
function installPolicies(
  options: BootOptions,
  driver: SqlDriver | undefined,
): Promise<Result<void, StoreFailure>> {
  if (options.rls !== true) return Promise.resolve(Result.ok(undefined));
  if (driver?.dialect !== "postgres")
    panic("rls compiles the read rules into Postgres policies: it needs a postgres driver");
  return installRls(driver, options.schema);
}

/**
 * Which stores this boot runs on: the caller's own log, the set they opened, a connection they
 * handed over, or the platform's durable default — decided once, here, so the boot below reads
 * as one path rather than four.
 */
function resolveStores(
  options: BootOptions,
  tables: readonly Table[],
): Promise<Result<Stores | undefined, MeshOpenError>> {
  if (options.store !== undefined) return Promise.resolve(Result.ok(undefined));
  if (options.stores !== undefined) return Promise.resolve(Result.ok(options.stores));
  const opened = omitUndefined({ tables, strict: options.strict });
  if (options.driver !== undefined) return openStores(options.driver, opened);
  return defaultStores(options.dataDir, String(options.identity.peerId), opened);
}

/**
 * The engine a boot opens: over the log it settled on, with the state cache, document columns,
 * shared transaction and undo depth the options and the opened stores supply.
 */
function engineSettings(
  options: BootOptions,
  opened: {
    readonly store: EventStore;
    readonly owned: Stores | undefined;
    readonly docs: DocColumns | undefined;
    readonly validate: Validator;
  },
): EngineOptions {
  const { store, owned, docs, validate } = opened;
  const engineOptions = {
    peerId: options.identity.peerId,
    clock: createHlcClock({ now: options.now, maxDrift: options.clockDrift ?? DEFAULT_MAX_DRIFT }),
    store,
    merge: options.schema.merge,
    validate,
  } satisfies EngineOptions;
  // the stamp on every event and cursors frame (D31); a schema that declares none stamps nothing
  const { schemaVersion } = options.schema;
  if (schemaVersion !== undefined) Object.assign(engineOptions, { schemaVersion });
  const stateStore = options.stateStore ?? owned?.state;
  if (stateStore !== undefined) Object.assign(engineOptions, { stateStore });
  if (docs !== undefined) Object.assign(engineOptions, { docs });
  // log and state share a connection exactly when the stores are one `openStores` pair; the
  // doc log lives beside the log it indexes and commits in the same transaction (RFC-0023 §6.3)
  if (options.store === undefined && owned !== undefined)
    Object.assign(engineOptions, {
      atomic: <T>(fn: (scoped: { events: EventStore; state?: StateStore }) => Promise<T>) =>
        owned.atomic(fn),
      docStore: owned.docs,
    });
  if (options.undoDepth !== undefined)
    Object.assign(engineOptions, { undoDepth: options.undoDepth });
  if (options.onError !== undefined) Object.assign(engineOptions, { onError: options.onError });
  return engineOptions;
}

/** Opens the stores the options name (or the platform default) and boots the engine over them (D05). */
export function openMeshEngine(options: BootOptions): Promise<Result<Booted, MeshOpenError>> {
  const { schema } = options;
  if (options.store === undefined && options.stateStore !== undefined)
    panic("storage.stateStore caches a log it was not given: pass `storage.store` alongside it");
  if (options.store !== undefined && options.driver !== undefined)
    panic("`storage.store` and `storage.driver` name two homes for one log: pass one");
  if (options.stores !== undefined && (options.store ?? options.driver) !== undefined)
    panic("`storage.stores` is already a log and a connection: pass it alone");
  return Result.gen(async function* () {
    const tables = syncedTables(schema);
    const owned = yield* Result.await(resolveStores(options, tables));
    // SAFETY: one of the two is defined — `owned` is opened exactly when `store` is absent
    const store = (options.store ?? owned?.events) as EventStore;
    // one map for both: a doc change the validator admits is one the fold joins by the lineage rule
    const docs = docColumns(schema);
    const validate = createValidator(validatorSettings(options, docs));
    const engine = yield* Result.await(
      openEngine(engineSettings(options, { store, owned, docs, validate })),
    );
    const booted = { engine, store, validate };
    if (owned?.rowSync !== undefined) Object.assign(booted, { rowSync: owned.rowSync });
    // the stores' own connection over yours: on a device it journals a write across both files,
    // and a ledger on the bare driver would write its log rows past the journal (RFC-0022)
    const driver = owned?.driver ?? options.driver;
    yield* Result.await(installPolicies(options, driver));
    if (driver !== undefined) {
      Object.assign(booted, { driver });
      // the ledger lives in the log's file: a receipt that lands in the background opens it (D39)
      const operations = yield* Result.await(
        operationStore(driver, omitUndefined({ beforeWrite: owned?.beforeWrite })),
      );
      Object.assign(booted, { operations });
      /*
       * Beside the device key, in the same table and for the same reason: both are true of this
       * database and neither may outlive it.
       *
       * **A lineage that will not read is not fatal, and the key is.** Without a key this device
       * has no name to sign events under and there is nothing to open; without a lineage it still
       * reads, writes, syncs and acknowledges — it just cannot sign for what it holds, so no peer
       * counts it as a custodian. Refusing to open over that would trade every working thing for
       * one that only other devices consult.
       */
      const lineage = await deviceIncarnation(driver);
      if (lineage.isOk()) Object.assign(booted, { incarnation: lineage.value });
      else
        console.warn(
          `[syncmesh] this store cannot sign for what it holds: ${lineage.error.message}`,
        );
    }
    // the same rule `close` follows below: stores you opened are yours to mark
    if (options.stores === undefined && owned !== undefined)
      Object.assign(booted, { session: { clean: owned.markClean, open: owned.markOpen } });
    return Result.ok({
      ...booted,
      // a driver or a set of stores you passed stays yours to close; the default store is ours.
      // Over your driver the session is still marked as ended cleanly, or every launch after
      // would check the log page by page as if the last one had crashed (D39)
      close: () => {
        if (options.stores !== undefined) return Promise.resolve();
        if (options.driver !== undefined) return owned?.markClean() ?? Promise.resolve();
        return owned?.close() ?? Promise.resolve();
      },
    });
  });
}

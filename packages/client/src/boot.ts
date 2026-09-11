import type {
  Engine,
  EngineOptions,
  EventStore,
  StateCorrupt,
  StateStore,
  StoreFailure,
  Validator,
  ValidatorOptions,
} from "@syncmesh/engine";
import type { MergeSpec, PeerId } from "@syncmesh/kernel";
import type { Table } from "@syncmesh/schema";
import type { OperationStore, SqlDriver, StoreLocked, Stores } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { Grant, Identity } from "@syncmesh/wire";

import { createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";
import { installRls, openStores, operationStore } from "@syncmesh/storage";

import { NoDefaultStore } from "./errors.js";

export type MeshOpenError = StoreFailure | StateCorrupt | NoDefaultStore | StoreLocked;

export interface BootOptions {
  /** What boot reads off the manifest: the validator's structural view, plus the merge rules. */
  readonly schema: ValidatorOptions["schema"] & { readonly merge: MergeSpec };
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
  /** Install RLS from the read rules on boot; postgres drivers only. */
  readonly rls?: boolean;
  readonly now: () => Temporal.Instant;
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
  /** The same ladder the engine runs on every write — for judging a captured transaction before it commits (D20). */
  readonly validate: Validator;
  readonly close: () => Promise<void>;
}

/**
 * The durable store this platform has — one SQLite file per identity under `dir` — or
 * `NoDefaultStore` where there is none yet: pass `store` there, memory included.
 */
async function defaultStores(
  dir: string,
  name: string,
  tables: readonly Table[],
): Promise<Result<Stores, MeshOpenError>> {
  if ("Bun" in globalThis) {
    const { defaultStore } = await import("@syncmesh/sqlite-bun");
    return defaultStore({ name, dir, tables });
  }
  if ("process" in globalThis) {
    const { defaultStore } = await import("@syncmesh/sqlite-node");
    return defaultStore({ name, dir, tables });
  }
  return Result.err(
    new NoDefaultStore({
      message:
        "no durable store on this platform yet (E04): pass `store` — `createMemoryEventStore()` to opt into memory",
    }),
  );
}

/** The validator an identity runs: grants when an issuer is configured, authorship when this process is the authority. */
function validatorFor(options: BootOptions): ValidatorOptions {
  const { schema, issuer, authority, grantFor, now } = options;
  const validatorOptions = {
    schema,
    grantFor: issuer === undefined ? null : grantFor,
    // being the authority is authorship, not a flag: this process is it when the named peer is us
    // arms the grace rung, and answers for a local write that has no stamp yet; an event
    // arriving from a peer carries its own, so both sides read it the same way
    now,
  } satisfies ValidatorOptions;
  if (authority !== undefined) Object.assign(validatorOptions, { authority });
  if (options.accounts === true) Object.assign(validatorOptions, { accounts: true });
  return validatorOptions;
}

/** `rls: true` compiles the read rules into the database's own policies — Postgres only. */
function policiesFor(
  options: BootOptions,
  driver: SqlDriver | undefined,
): Promise<Result<void, StoreFailure>> {
  if (options.rls !== true) return Promise.resolve(Result.ok(undefined));
  if (driver?.dialect !== "postgres")
    panic("rls compiles the read rules into Postgres policies: it needs a postgres driver");
  return installRls(driver, options.schema);
}

/** Opens the stores the options name (or the platform default) and boots the engine over them (D05). */
export function openMeshEngine(options: BootOptions): Promise<Result<Booted, MeshOpenError>> {
  const { schema, identity, now } = options;
  if (options.store === undefined && options.stateStore !== undefined)
    panic("stateStore caches a log it was not given: pass `store` alongside it");
  if (options.store !== undefined && options.driver !== undefined)
    panic("`store` and `driver` name two homes for one log: pass one");
  if (options.stores !== undefined && (options.store ?? options.driver) !== undefined)
    panic("`stores` is already a log and a connection: pass it alone");
  return Result.gen(async function* () {
    const tables = schema.entries.map((e) => e.table);
    const owned =
      options.store !== undefined
        ? undefined
        : options.stores !== undefined
          ? options.stores
          : options.driver !== undefined
            ? yield* Result.await(openStores(options.driver, { tables }))
            : yield* Result.await(defaultStores(options.dataDir, String(identity.peerId), tables));
    // SAFETY: one of the two is defined — `owned` is opened exactly when `store` is absent
    const store = (options.store ?? owned?.events) as EventStore;
    const validate = createValidator(validatorFor(options));
    const engineOptions = {
      peerId: identity.peerId,
      clock: createHlcClock({ now }),
      store,
      merge: schema.merge,
      validate,
    } satisfies EngineOptions;
    const stateStore = options.stateStore ?? owned?.state;
    if (stateStore !== undefined) Object.assign(engineOptions, { stateStore });
    // log and state share a connection exactly when the stores are one `openStores` pair
    if (options.store === undefined && owned !== undefined)
      Object.assign(engineOptions, {
        atomic: <T>(fn: (scoped: { events: EventStore; state?: StateStore }) => Promise<T>) =>
          owned.atomic(fn),
      });
    if (options.undoDepth !== undefined)
      Object.assign(engineOptions, { undoDepth: options.undoDepth });
    const engine = yield* Result.await(openEngine(engineOptions));
    const booted = { engine, store, validate };
    const driver = options.driver ?? owned?.driver;
    yield* Result.await(policiesFor(options, driver));
    if (driver !== undefined) {
      Object.assign(booted, { driver });
      const operations = yield* Result.await(operationStore(driver));
      Object.assign(booted, { operations });
    }
    return Result.ok({
      ...booted,
      // a driver or a set of stores you passed stays yours to close; the default store is ours
      close: () =>
        (options.driver ?? options.stores) !== undefined
          ? Promise.resolve()
          : (owned?.close() ?? Promise.resolve()),
    });
  });
}

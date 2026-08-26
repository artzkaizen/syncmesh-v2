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
import type { SqliteDriver, Stores } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { Grant, Identity } from "@syncmesh/wire";

import { createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";
import { openStores } from "@syncmesh/storage";

import { NoDefaultStore } from "./errors.js";

export type MeshOpenError = StoreFailure | StateCorrupt | NoDefaultStore;

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
  readonly driver?: SqliteDriver;
  readonly dataDir: string;
  readonly now: () => Temporal.Instant;
  readonly grantFor: (peer: PeerId) => Grant | undefined;
}

/** A booted engine, the log it runs on, its validator, and how to let go of what was opened for it; a store you passed in stays yours. */
export interface Booted {
  readonly engine: Engine;
  readonly store: EventStore;
  /** The SQL connection the tables live on; absent for a mesh over a bare event store. */
  readonly driver?: SqliteDriver;
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

/** Opens the stores the options name (or the platform default) and boots the engine over them (D05). */
export function openMeshEngine(options: BootOptions): Promise<Result<Booted, MeshOpenError>> {
  const { schema, identity, issuer, authority, grantFor, now } = options;
  if (options.store === undefined && options.stateStore !== undefined)
    panic("stateStore caches a log it was not given: pass `store` alongside it");
  if (options.store !== undefined && options.driver !== undefined)
    panic("`store` and `driver` name two homes for one log: pass one");
  return Result.gen(async function* () {
    const tables = schema.entries.map((e) => e.table);
    const owned =
      options.store !== undefined
        ? undefined
        : options.driver !== undefined
          ? yield* Result.await(openStores(options.driver, { tables }))
          : yield* Result.await(defaultStores(options.dataDir, String(identity.peerId), tables));
    const validatorOptions = {
      schema,
      grantFor: issuer === undefined ? null : grantFor,
      // being the authority is authorship, not a flag: this process is it when the named peer is us
      isAuthority: authority !== undefined && authority === identity.peerId,
    } satisfies ValidatorOptions;
    if (authority !== undefined) Object.assign(validatorOptions, { authority });
    // SAFETY: one of the two is defined — `owned` is opened exactly when `store` is absent
    const store = (options.store ?? owned?.events) as EventStore;
    const validate = createValidator(validatorOptions);
    const engineOptions = {
      peerId: identity.peerId,
      clock: createHlcClock({ now }),
      store,
      merge: schema.merge,
      validate,
    } satisfies EngineOptions;
    const stateStore = options.stateStore ?? owned?.state;
    if (stateStore !== undefined) Object.assign(engineOptions, { stateStore });
    if (options.undoDepth !== undefined)
      Object.assign(engineOptions, { undoDepth: options.undoDepth });
    const engine = yield* Result.await(openEngine(engineOptions));
    const booted = { engine, store, validate };
    const driver = options.driver ?? owned?.driver;
    if (driver !== undefined) Object.assign(booted, { driver });
    return Result.ok({
      ...booted,
      // a driver you passed stays yours to close; the default store is ours
      close: () =>
        options.driver !== undefined ? Promise.resolve() : (owned?.close() ?? Promise.resolve()),
    });
  });
}

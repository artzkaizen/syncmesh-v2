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
import type { Stores } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { Grant, Identity } from "@syncmesh/wire";

import { createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";

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
  readonly dataDir: string;
  readonly now: () => Temporal.Instant;
  readonly grantFor: (peer: PeerId) => Grant | undefined;
}

/** A booted engine, the log it runs on, its validator, and how to let go of what was opened for it; a store you passed in stays yours. */
export interface Booted {
  readonly engine: Engine;
  readonly store: EventStore;
  /** The same ladder the engine runs on every write — for judging a captured transaction before it commits (D20). */
  readonly validate: Validator;
  readonly close: () => Promise<void>;
}

/**
 * The durable store this platform has — one SQLite file per identity under `dir` — or
 * `NoDefaultStore` where there is none yet: pass `store` there, memory included.
 */
async function defaultStores(dir: string, name: string): Promise<Result<Stores, MeshOpenError>> {
  if ("Bun" in globalThis) {
    const { defaultStore } = await import("@syncmesh/sqlite-bun");
    return defaultStore({ name, dir });
  }
  if ("process" in globalThis) {
    const { defaultStore } = await import("@syncmesh/sqlite-node");
    return defaultStore({ name, dir });
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
  return Result.gen(async function* () {
    const owned =
      options.store === undefined
        ? yield* Result.await(defaultStores(options.dataDir, String(identity.peerId)))
        : undefined;
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
    return Result.ok({ engine, store, validate, close: () => owned?.close() ?? Promise.resolve() });
  });
}

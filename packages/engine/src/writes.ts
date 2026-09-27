import type { HlcClock, PeerId, State } from "@syncmesh/kernel";

import { type Procedure, type SyncEvent } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { AtomicStores, Engine, FoldBatch, FoldSource, MutateOptions } from "./engine.js";
import type { ValidationError } from "./errors.js";
import type { PersistInto } from "./fold.js";
import type { Hub } from "./listeners.js";
import type { StoredEvent } from "./store.js";
import type { TelemetryEvent } from "./telemetry.js";
import type { Undo } from "./undo.js";
import type { ProbeEvent, StateLookup, Validator } from "./validate.js";

import { buildEvent, nextSeq } from "./build-event.js";
import { EmptyMutation } from "./errors.js";
import { StoreFailure } from "./store.js";
import { timed } from "./telemetry.js";
import { record } from "./tx.js";
import { invert } from "./undo.js";

/** What escaped an `atomic` body: a store's own failure as itself, anything else wrapped. */
const asStoreFailure = (cause: unknown): StoreFailure =>
  cause instanceof StoreFailure
    ? cause
    : new StoreFailure({ message: "the write's transaction failed", cause });

/** Inside an `atomic` body a store's `Err` must abort the transaction: thrown as itself, caught above. */
const orThrow = <T>(result: Result<T, StoreFailure>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

/** The verdict a probe gets before a local write is numbered; `undefined` when nothing validates. */
const probeVerdict = (
  validate: Validator | undefined,
  probe: ProbeEvent,
  before: StateLookup,
): Result<void, ValidationError> | undefined => validate?.validate(probe, before);

const probeOf = (
  peerId: PeerId,
  changes: ProbeEvent["changes"],
  options: MutateOptions,
): ProbeEvent => {
  const probe: ProbeEvent =
    options.local === true ? { peerId, changes, local: true } : { peerId, changes };
  return options.partition === undefined ? probe : { ...probe, partition: options.partition };
};

export interface WriteDeps {
  readonly peerId: PeerId;
  readonly clock: HlcClock;
  readonly validate?: Validator | undefined;
  readonly before: StateLookup;
  readonly undoDepth: number;
  readonly undo: Undo[];
  readonly atomically: <T>(fn: (scoped: AtomicStores) => Promise<T>) => Promise<T>;
  readonly stateOf: () => State;
  readonly fold: (entries: readonly StoredEvent[], source: FoldSource) => FoldBatch;
  readonly persist: (batch: FoldBatch, into: PersistInto) => Promise<void>;
  readonly notify: (batch: FoldBatch) => void;
  readonly outbound: Hub<SyncEvent>;
  readonly telemetry: Hub<TelemetryEvent>;
  readonly admitEntries: (
    entries: readonly StoredEvent[],
  ) => Promise<Result<{ fresh: readonly StoredEvent[]; quarantined: number }, StoreFailure>>;
}

/**
 * The two paths a write takes into the engine — its own `mutate`, a peer's `receiveBatch` — with
 * one shape: append and state commit inside `atomically`, the fold notification after it.
 */
export function createWritePath(deps: WriteDeps) {
  const {
    peerId,
    clock,
    validate,
    before,
    undoDepth,
    undo,
    atomically,
    stateOf,
    fold,
    persist,
    notify,
    outbound,
    telemetry,
    admitEntries,
  } = deps;

  const mutate: Engine["mutate"] = (procedure: Procedure, fn, mutateOptions = {}) =>
    Result.gen(async function* () {
      const [changes, duration] = timed(() => record(fn));
      if (changes.length === 0) {
        return Result.err(
          new EmptyMutation({ procedure, message: `${procedure} changed nothing` }),
        );
      }
      const verdict = probeVerdict(validate, probeOf(peerId, changes, mutateOptions), before);
      if (verdict !== undefined) yield* verdict;
      const inverse = undoDepth > 0 ? invert(stateOf(), changes) : [];
      const hlc = clock.tick();
      const scope = mutateOptions.local === true ? "local" : "synced";
      telemetry.emit({ type: "engine.mutate", sizes: { changes: changes.length }, duration });
      const built = yield* Result.await(
        Result.tryPromise({
          try: () =>
            atomically(async (scoped) => {
              const last = (await scoped.events.lastSeq(peerId, scope)).unwrap();
              const event = buildEvent(
                peerId,
                procedure,
                hlc,
                nextSeq(last),
                changes,
                mutateOptions,
              );
              (await scoped.events.append({ event })).unwrap();
              const folded = fold([{ event }], "local");
              await persist(folded, scoped);
              return { event, folded };
            }),
          catch: (cause) => asStoreFailure(cause),
        }),
      );
      notify(built.folded);
      if (undoDepth > 0) {
        undo.push({ event: built.event, inverse });
        if (undo.length > undoDepth) undo.shift();
      }
      if (built.event.local !== true) outbound.emit(built.event);
      return Result.ok(built.event);
    });

  const receiveBatch: Engine["receiveBatch"] = (entries) =>
    Result.gen(async function* () {
      const { fresh, quarantined } = yield* Result.await(admitEntries(entries));
      for (const { event } of fresh) clock.receive(event.hlc);
      const batch = yield* Result.await(
        Result.tryPromise({
          try: () =>
            atomically(async (scoped) => {
              orThrow(await scoped.events.appendBatch(fresh));
              const folded = fold(fresh, "remote");
              await persist(folded, scoped);
              return folded;
            }),
          catch: (cause) => asStoreFailure(cause),
        }),
      );
      notify(batch);
      return Result.ok({
        folded: fresh.length,
        skipped: entries.length - fresh.length - quarantined,
        quarantined,
      });
    });

  return { mutate, receiveBatch };
}

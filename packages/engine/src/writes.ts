import type { HlcClock, PeerId, SeqNum, State } from "@syncmesh/kernel";

import { type Procedure, type SyncEvent } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { AtomicStores, Engine, FoldBatch, FoldSource, MutateOptions } from "./engine.js";
import type { ValidationError } from "./errors.js";
import type { Hub } from "./listeners.js";
import type { OwnPosition } from "./own-position.js";
import type { StateStore } from "./state-store.js";
import type { StoredEvent } from "./store.js";
import type { TelemetryEvent } from "./telemetry.js";
import type { Undo } from "./undo.js";
import type { ProbeEvent, StateLookup, Validator } from "./validate.js";

import { buildEvent, nextSeq } from "./build-event.js";
import { EmptyMutation } from "./errors.js";
import { adoptOwnPosition, createOwnFloor, pastFloor } from "./own-position.js";
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

export interface OwnPositionApi {
  /**
   * Takes on a room's position for this device's own author — its `hello` cursors — so nothing is
   * ever numbered at or below it again (RFC 0024 G7). A key that outlives its log would otherwise
   * number writes the room already holds, and every peer drops those as duplicates without a
   * word. Says whether this log's own writes were caught in that range ({@link OwnPosition}).
   */
  readonly adoptOwnPosition: (room: SeqNum) => Promise<Result<OwnPosition, StoreFailure>>;
}

export interface WriteDeps {
  readonly peerId: PeerId;
  readonly clock: HlcClock;
  readonly validate?: Validator | undefined;
  readonly before: StateLookup;
  readonly undoDepth: number;
  readonly undo: Undo[];
  readonly atomically: <T>(fn: (scoped: AtomicStores) => Promise<T>) => Promise<T>;
  readonly getState: () => State;
  readonly fold: (entries: readonly StoredEvent[], source: FoldSource) => FoldBatch;
  readonly persist: (batch: FoldBatch, into: StateStore | undefined) => Promise<void>;
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
    getState,
    fold,
    persist,
    notify,
    outbound,
    telemetry,
    admitEntries,
  } = deps;
  // own sequences known to exist outside this log (G7): numbering never goes at or below it
  const ownFloor = createOwnFloor();

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
      const inverse = undoDepth > 0 ? invert(getState(), changes) : [];
      const hlc = clock.tick();
      const scope = mutateOptions.local === true ? "local" : "synced";
      telemetry.emit({ type: "engine.mutate", sizes: { changes: changes.length }, duration });
      const built = yield* Result.await(
        Result.tryPromise({
          try: () =>
            atomically(async (scoped) => {
              const last = (await scoped.events.lastSeq(peerId, scope)).unwrap();
              // after the log and after anything a room said it holds of ours: a number reused is
              // a write every peer drops as a duplicate, silently (G7). Local writes never travel,
              // so their run is this log's alone
              const floor = scope === "synced" ? ownFloor.get() : 0;
              const event = buildEvent(
                peerId,
                procedure,
                hlc,
                nextSeq(pastFloor(last, floor)),
                changes,
                mutateOptions,
              );
              (await scoped.events.append({ event })).unwrap();
              /**
               * **The ledger row belongs to the durable half, so it lands with the event.**
               *
               * It used to be written after `persist`, which was harmless while one transaction
               * covered both — and is not, the moment the log and the derived state can commit
               * separately (RFC-0022). A tear there left a write that happened with no record
               * that it had been started, which is the one thing the record exists to prevent:
               * its `id` is minted *before* the commit so an interrupted caller can find it.
               *
               * Above `persist` rather than below, and that is the whole ordering rule: whatever
               * cannot be recomputed goes first, whatever can goes second, and a crash between
               * them costs a replay rather than a fact.
               */
              await mutateOptions.record?.(event);
              const folded = fold([{ event }], "local");
              await persist(folded, scoped.state);
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
      for (const { event } of fresh) {
        clock.receive(event.hlc);
        // an own event taken back (see `admit`): a write this device made, so never numbered over
        if (event.peerId === peerId) ownFloor.raise(Number(event.seqNum));
      }
      const batch = yield* Result.await(
        Result.tryPromise({
          try: () =>
            atomically(async (scoped) => {
              orThrow(await scoped.events.appendBatch(fresh));
              const folded = fold(fresh, "remote");
              await persist(folded, scoped.state);
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

  const adoptOwn: OwnPositionApi["adoptOwnPosition"] = (room) =>
    atomically((scoped) => adoptOwnPosition(scoped.events, peerId, ownFloor, room));

  return { mutate, receiveBatch, adoptOwnPosition: adoptOwn };
}

import type { Change, Hlc, HlcClock, PeerId, SeqNum, State } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import { getRecord, docLineage, type Procedure, type SyncEvent } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { AtomicStores, Engine, FoldBatch, FoldSource, MutateOptions } from "./engine.js";
import type { MutateError, ValidationError } from "./errors.js";
import type { FoldPath, PersistInto } from "./fold.js";
import type { Hub } from "./listeners.js";
import type { OwnPosition } from "./own-position.js";
import type { StoredEvent } from "./store.js";
import type { TelemetryEvent } from "./telemetry.js";
import type { Undo } from "./undo.js";
import type { ProbeEvent, StateLookup, Validator } from "./validate.js";

import { buildEvent, nextSeq } from "./build-event.js";
import { EmptyMutation } from "./errors.js";
import { withDerivedKeys } from "./fold.js";
import { adoptOwnPosition, createOwnFloor, pastFloor } from "./own-position.js";
import { StoreFailure, orThrow } from "./store.js";
import { timed } from "./telemetry.js";
import { record } from "./tx.js";
import { rowsBefore } from "./undo.js";

/** What escaped an `atomic` body: a store's own failure as itself, anything else wrapped. */
const asStoreFailure = (cause: unknown): StoreFailure =>
  cause instanceof StoreFailure
    ? cause
    : new StoreFailure({ message: "the write's transaction failed", cause });

const nothingChanged = (procedure: Procedure) =>
  new EmptyMutation({ procedure, message: `${procedure} changed nothing` });

/** Carries a captured write's refusal out through its transaction's rollback, as itself. */
class Declined<E> {
  constructor(readonly error: E) {}
}

/** A write whose changes the engine did not record: what `mutateCaptured`'s capture hands back. */
export interface CapturedWrite {
  readonly procedure: Procedure;
  readonly changes: readonly Change[];
  readonly options?: MutateOptions;
}

/** How `mutateCaptured` runs. */
export interface CaptureSettings {
  /**
   * A transaction on the capture's connection, for an engine whose stores have no `atomic`: the
   * statements commit in it, and the event after it. Ignored with `atomic`, where the capture runs
   * inside the engine's own transaction — so on the connection `atomic` runs on.
   */
  readonly around?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** `Engine.mutateCaptured`. */
export type MutateCaptured = <E>(
  capture: () => Promise<Result<CapturedWrite, E>>,
  settings?: CaptureSettings,
) => Promise<Result<SyncEvent, MutateError | E>>;

/** A write admitted and stamped, ready to be numbered inside its transaction. */
interface Prepared {
  readonly procedure: Procedure;
  readonly changes: readonly Change[];
  readonly options: MutateOptions;
  readonly image: Undo["before"];
  readonly hlc: Hlc;
}

/** The verdict a probe gets before a local write is numbered; `undefined` when nothing validates. */
const probeVerdict = (
  validate: Validator | undefined,
  probe: ProbeEvent,
  before: StateLookup,
): Result<void, ValidationError> | undefined => validate?.validate(probe, before);

const probeEvent = (
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
  /** Whether `atomically` is one transaction over the engine's stores (`EngineOptions.atomic`). */
  readonly atomic: boolean;
  readonly getState: () => State;
  readonly fold: (entries: readonly StoredEvent[], source: FoldSource) => FoldBatch;
  readonly persist: (batch: FoldBatch, into: PersistInto) => Promise<void>;
  readonly notify: (batch: FoldBatch) => void;
  readonly derive: FoldPath["derive"];
  readonly outbound: Hub<SyncEvent>;
  readonly telemetry: Hub<TelemetryEvent>;
  readonly admitEntries: (
    entries: readonly StoredEvent[],
  ) => Promise<Result<{ fresh: readonly StoredEvent[]; quarantined: number }, StoreFailure>>;
}

/**
 * The paths a write takes into the engine — its own `mutate` and `mutateCaptured`, a peer's
 * `receiveBatch` — with one shape: append and state commit inside `atomically`, the fold
 * notification after it.
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
    atomic,
    getState,
    fold,
    persist,
    notify,
    derive,
    outbound,
    telemetry,
    admitEntries,
  } = deps;
  // own sequences known to exist outside this log (G7): numbering never goes at or below it
  const ownFloor = createOwnFloor();

  /** Refuses an empty or invalid write, and stamps one that passes; nothing is numbered yet. */
  const prepare = (
    procedure: Procedure,
    changes: readonly Change[],
    options: MutateOptions,
    duration: Temporal.Duration,
  ): Result<Prepared, MutateError> => {
    if (changes.length === 0) {
      return Result.err(nothingChanged(procedure));
    }
    const verdict = probeVerdict(validate, probeEvent(peerId, changes, options), before);
    if (verdict !== undefined && verdict.isErr()) return Result.err(verdict.error);
    const image = undoDepth > 0 ? rowsBefore(getState(), changes) : [];
    const hlc = clock.tick();
    telemetry.emit({ type: "engine.mutate", sizes: { changes: changes.length }, duration });
    return Result.ok({ procedure, changes, options, image, hlc });
  };

  /** Numbers, appends, records and folds a prepared write inside the transaction `scoped` is in. */
  const commit = async (scoped: AtomicStores, prepared: Prepared) => {
    const { procedure, changes, options: mutateOptions, hlc } = prepared;
    const scope = mutateOptions.local === true ? "local" : "synced";
    const last = (await scoped.events.lastSeq(peerId, scope)).unwrap();
    // after the log and after anything a room said it holds of ours: a number reused is a write
    // every peer drops as a duplicate, silently (G7). Local writes never travel, so their run is
    // this log's alone
    const floor = scope === "synced" ? ownFloor.get() : 0;
    const event = buildEvent(
      peerId,
      procedure,
      hlc,
      nextSeq(pastFloor(last, floor)),
      changes,
      mutateOptions,
      (doc) => docLineage(getRecord(getState(), doc.table, doc.key), doc.column),
    );
    (await scoped.events.append({ event })).unwrap();
    /**
     * **The ledger row belongs to the durable half, so it lands with the event.**
     *
     * It used to be written after `persist`, which was harmless while one transaction covered
     * both — and is not, the moment the log and the derived state can commit separately
     * (RFC-0022). A tear there left a write that happened with no record that it had been
     * started, which is the one thing the record exists to prevent: its `id` is minted *before*
     * the commit so an interrupted caller can find it.
     */
    await mutateOptions.record?.(event);
    const derived = mutateOptions.derived ?? [];
    const folded = fold([{ event }], "local");
    await persist(folded, scoped);
    await derive(derived, scoped);
    return { event, folded: withDerivedKeys(folded, derived) };
  };

  /** After the transaction: listeners, the undo stack, and the outbound hub, in that order. */
  const publish = (
    built: { readonly event: SyncEvent; readonly folded: FoldBatch },
    image: Undo["before"],
  ) => {
    notify(built.folded);
    if (undoDepth > 0) {
      undo.push({ event: built.event, before: image });
      if (undo.length > undoDepth) undo.shift();
    }
    if (built.event.local !== true) outbound.emit(built.event);
  };

  const mutate: Engine["mutate"] = (procedure: Procedure, fn, mutateOptions = {}) =>
    Result.gen(async function* () {
      const [changes, duration] = timed(() => record(fn));
      const prepared = yield* prepare(procedure, changes, mutateOptions, duration);
      const built = yield* Result.await(
        Result.tryPromise({
          try: () => atomically((scoped) => commit(scoped, prepared)),
          catch: (cause) => asStoreFailure(cause),
        }),
      );
      publish(built, prepared.image);
      return Result.ok(built.event);
    });

  /**
   * The capture, judged and stamped: `undefined` for statements that changed no synced row, which
   * are no event and still commit — a write to a table nothing syncs is the app's own business.
   * A refusal is thrown as a {@link Declined}, so the transaction around it rolls back.
   */
  const captureInside = async <E>(capture: () => Promise<Result<CapturedWrite, E>>) => {
    const [captured, duration] = await timed(capture);
    if (captured.isErr()) throw new Declined(captured.error);
    const { procedure, changes, options = {} } = captured.value;
    if (changes.length === 0) return { procedure, prepared: undefined };
    const prepared = prepare(procedure, changes, options, duration);
    if (prepared.isErr()) throw new Declined(prepared.error);
    return { procedure, prepared: prepared.value };
  };

  const mutateCaptured: MutateCaptured = <E>(
    capture: () => Promise<Result<CapturedWrite, E>>,
    settings: CaptureSettings = {},
  ) =>
    Result.gen(async function* () {
      const written = yield* Result.await(
        Result.tryPromise({
          try: async () => {
            if (atomic || settings.around === undefined)
              return atomically(async (scoped) => {
                const { procedure, prepared } = await captureInside(capture);
                if (prepared === undefined) return { procedure, built: undefined };
                return { procedure, built: { ...(await commit(scoped, prepared)), prepared } };
              });
            // no transaction spans the engine's stores here, so the statements commit in
            // `around` first and the event after them, each store on its own (`EngineOptions.atomic`)
            const { procedure, prepared } = await settings.around(() => captureInside(capture));
            if (prepared === undefined) return { procedure, built: undefined };
            const built = await atomically((scoped) => commit(scoped, prepared));
            return { procedure, built: { ...built, prepared } };
          },
          catch: (cause) =>
            // SAFETY: a Declined is thrown above with the capture's own error or a MutateError
            cause instanceof Declined ? (cause.error as E | MutateError) : asStoreFailure(cause),
        }),
      );
      if (written.built === undefined) return Result.err(nothingChanged(written.procedure));
      publish(written.built, written.built.prepared.image);
      return Result.ok(written.built.event);
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

  const adoptOwn: OwnPositionApi["adoptOwnPosition"] = (room) =>
    atomically((scoped) => adoptOwnPosition(scoped.events, peerId, ownFloor, room));

  return { mutate, mutateCaptured, receiveBatch, adoptOwnPosition: adoptOwn };
}

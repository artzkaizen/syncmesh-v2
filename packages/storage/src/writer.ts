import type {
  Engine,
  MutateError,
  Principal,
  StateLookup,
  StoreFailure,
  Validator,
  ValidatorSchema,
} from "@syncmesh/engine";
import type { Change, EventId, PartitionKey, Procedure, SyncEvent } from "@syncmesh/kernel";
import type { Table } from "@syncmesh/schema";

import { createPolicyDenied, can, why, type PolicyDenied } from "@syncmesh/engine";
import { getRecord, readRow } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { SqlDriver } from "./driver.js";
import type { OperationStore } from "./operation-store.js";

import { captureChanges, captureWithin } from "./capture.js";
import { inTransaction } from "./sql.js";

/** One committed transaction: the event it appended, for `delivered` and `revert`. */
export interface TxReceipt {
  readonly eventId: EventId;
  /** The durable operation record's id — allocated before commit, absent for local-only writes or a writer with no store. */
  readonly operationId?: string;
}

/**
 * D20's write path: the app writes its tables with its own SQL; this turns that transaction into
 * one signed event. The schema and policy verdict runs inside the transaction, before COMMIT, so a
 * refused write never reaches the table — the same ladder every receiving peer runs.
 */

export interface WriteOptions {
  /** The instance the transaction's rows belong to; every change of one event shares it. */
  readonly partition?: PartitionKey;
  /**
   * The operation id to record this write under, allocated by the caller **before** the call
   * (book ch. 10). A `Write` handle hands its id back synchronously, so the id cannot be
   * something the commit returns — a caller that crashed mid-commit has to be able to look up
   * what it started, and an id it never saw is one it cannot ask about.
   */
  readonly operationId?: string;
}

export type WriteError = MutateError | StoreFailure;

export interface WriterDeps {
  readonly engine: Engine;
  readonly validate: Validator;
  /**
   * The connection the app's tables live on, with capture installed: the one the engine's
   * `atomic` runs on (`Stores.driver`), or any connection when the engine has no `atomic`. The
   * capture runs inside the engine's write transaction, so on another connection it would commit
   * apart from its event.
   */
  readonly driver: SqlDriver;
  readonly tables: readonly Table[];
  /**
   * Act as this principal: each captured change is also judged by the schema's rules for them,
   * before COMMIT — what a server does on a caller's behalf, refused as `PolicyDenied` when the
   * caller may not. Needs `schema`. The event stays the device's.
   */
  readonly actor?: Principal;
  readonly schema?: ValidatorSchema;
  /**
   * Writes each synced commit's durable operation record inside the same transaction (book
   * ch. 10). Local-only writes never travel, so they get no record.
   */
  readonly operations?: OperationStore;
  readonly now?: () => Temporal.Instant;
}

/** The event's procedure label: given, or derived from what the transaction turned out to change. */
export type WriteLabel = string | ((changes: readonly Change[]) => string);

export interface Write {
  (
    label: WriteLabel,
    fn: () => Promise<void>,
    options?: WriteOptions,
  ): Promise<Result<TxReceipt, WriteError>>;
  /**
   * The same write, rehearsed (book ch. 15): the statements run against the replica, the
   * captured changes face the same ladder every receiver runs, and the transaction always rolls
   * back. `Ok` means it would have been allowed; the `Err` is the refusal itself, reason and
   * all — which is why a rehearsal cannot drift from enforcement the way a second copy of the
   * rules in UI code does.
   */
  readonly rehearse: (
    fn: () => Promise<void>,
    options?: WriteOptions,
  ) => Promise<Result<void, WriteError>>;
}

/** Forces the rehearsal's rollback once the verdict is in hand; never leaves this module. */
class Rehearsed extends TaggedError("Rehearsed")<{ message?: string }> {}

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- procedures are `table.op` labels */
const procedure = (label: string): Procedure => label as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export function createWriter(deps: WriterDeps): Write {
  const { engine, validate, driver, tables, actor, schema } = deps;
  const localTables = new Set(
    (schema?.entries ?? [])
      .filter((entry) => entry.partition === "local")
      .map((entry) => String(entry.table.name)),
  );
  const before: StateLookup = {
    row: (table, key) => readRow(engine.state(), table, key),
    partition: (table, key) => getRecord(engine.state(), table, key)?.partition,
  };
  /**
   * The actor's verdict on one change — the same AST the device's own validator runs, for another
   * principal, read from the same place: the instance's synced `_policy` doc when the transaction
   * names an instance, the bundled manifest when it does not.
   */
  const actorDenies = (
    change: Change,
    partition: PartitionKey | undefined,
  ): PolicyDenied | undefined => {
    if (actor === undefined || schema === undefined) return undefined;
    const row = before.row(change.table, change.key);
    const patch =
      change.kind === "insert" ? change.row : change.kind === "update" ? change.patch : undefined;
    const source = partition === undefined ? undefined : { partition, rows: before.row };
    const what = `${change.table}.${change.kind}` as const;
    if (can(schema, actor, what, row, patch, source)) return undefined;
    // the same why the receivers would give, asked only now that the answer is no
    const answer = why(schema, actor, what, row, patch, source);
    return createPolicyDenied(change.table, change.key, change.kind, answer);
  };
  /**
   * Locality is the schema's, decided from what the transaction turned out to touch: wholly on
   * `local` tables, the event never leaves this device. A transaction that mixes local and
   * synced tables gets no flag, so its local change fails validation (`LocalOnly`) and the
   * whole transaction rolls back — one event cannot both travel and stay.
   */
  const mutateSettings = (options: WriteOptions, captured: readonly Change[]) => {
    const mutateOptions = {};
    if (options.partition !== undefined)
      Object.assign(mutateOptions, { partition: options.partition });
    if (captured.length > 0 && captured.every((c) => localTables.has(String(c.table))))
      Object.assign(mutateOptions, { local: true });
    return mutateOptions;
  };
  /** The verdict on one transaction's changes: the actor's rules, then the schema's ladder. */
  const judge =
    (options: WriteOptions) =>
    (captured: readonly Change[]): Result<void, WriteError> => {
      if (captured.length === 0) return Result.ok(undefined);
      const denied = captured
        .map((change) => actorDenies(change, options.partition))
        .find((d) => d !== undefined);
      if (denied !== undefined) return Result.err(denied);
      return validate.validate(
        { peerId: engine.peerId, changes: captured, ...mutateSettings(options, captured) },
        before,
      );
    };

  const rehearse: Write["rehearse"] = async (fn, options = {}) => {
    let verdict: Result<void, WriteError> = Result.ok(undefined);
    const captureOptions = {
      check: (captured: readonly Change[]) => {
        verdict = judge(options)(captured);
        // the verdict is in hand; refusing here is what rolls the whole rehearsal back
        return Result.err(new Rehearsed({ message: "rehearsal rolls back" }));
      },
    };
    if (options.partition !== undefined)
      Object.assign(captureOptions, { partition: options.partition });
    const ran = await captureChanges(driver, tables, fn, captureOptions);
    // a failure that is not the sentinel is a real one — a broken statement, a dead connection
    if (ran.isErr() && !(ran.error instanceof Rehearsed)) return Result.err(ran.error);
    return verdict;
  };

  /** The operation record's seat (book ch. 10) for a synced write, and the id it records under. */
  const recordSeat = (name: string, options: WriteOptions) => {
    const store = deps.operations;
    if (store === undefined) return undefined;
    const id = options.operationId ?? crypto.randomUUID();
    const record = async (event: SyncEvent) => {
      const row = {
        id,
        peer: event.peerId,
        seq: event.seqNum,
        label: name,
        atMs: (deps.now?.() ?? Temporal.Now.instant()).epochMilliseconds,
        // the write's own stamp, so a row can find this record by what it already carries
        hlcMs: event.hlc[0].epochMilliseconds,
        hlcLogical: Number(event.hlc[1]),
      };
      (await store.record(row)).unwrap();
    };
    return { id, record };
  };

  const write: Write = Object.assign(
    (label: WriteLabel, fn: () => Promise<void>, options: WriteOptions = {}) =>
      Result.gen(async function* () {
        const captureOptions = { check: judge(options) };
        if (options.partition !== undefined)
          Object.assign(captureOptions, { partition: options.partition });
        let operationId: string | undefined;
        /*
         * The app's statements, the event, its ledger row and the state commit are one
         * transaction: the engine opens it and runs the capture first inside it. Two — the rows
         * committed, then the event — left a row with no event behind a crash between them, a
         * write that is local forever and that nothing can see (RFC-0022).
         */
        const event = yield* Result.await(
          engine.mutateCaptured(
            async () => {
              const captured = await captureWithin(driver, tables, fn, captureOptions);
              if (captured.isErr()) return Result.err(captured.error);
              const changes = captured.value;
              const name = label instanceof Function ? label(changes) : label;
              const mutateOptions = mutateSettings(options, changes);
              // local-only writes never travel, so they get no record
              const seat =
                changes.length > 0 && !("local" in mutateOptions)
                  ? recordSeat(name, options)
                  : undefined;
              if (seat !== undefined) {
                operationId = seat.id;
                Object.assign(mutateOptions, { record: seat.record });
              }
              return Result.ok({ procedure: procedure(name), changes, options: mutateOptions });
            },
            // for an engine with no `atomic`: the statements commit here, the event after them
            { around: (body) => inTransaction(driver, body) },
          ),
        );
        const receipt = { eventId: event.id };
        if (operationId !== undefined) Object.assign(receipt, { operationId });
        return Result.ok(receipt);
      }),
    { rehearse },
  );
  return write;
}

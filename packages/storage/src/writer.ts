import type {
  Engine,
  MutateError,
  Principal,
  StateLookup,
  StoreFailure,
  Tx,
  Validator,
  ValidatorSchema,
} from "@syncmesh/engine";
import type { Change, EventId, PartitionKey, Procedure, SyncEvent } from "@syncmesh/kernel";
import type { Table } from "@syncmesh/schema";

import { EmptyMutation, PolicyDenied, can } from "@syncmesh/engine";
import { getRecord, readRow } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { SqlDriver } from "./driver.js";
import type { OperationStore } from "./operation-store.js";

import { captureChanges } from "./capture.js";

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
  /** The connection the app's tables live on; capture is installed on it. */
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

/** The captured changes, applied to the engine's recording tx exactly as the app made them. */
const replay = (tx: Tx, changes: readonly Change[]): void => {
  for (const change of changes) {
    if (change.kind === "insert") tx.insert(change.table, change.key, change.row);
    else if (change.kind === "update") tx.update(change.table, change.key, change.patch);
    else tx.delete(change.table, change.key);
  }
};

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
    if (can(schema, actor, `${String(change.table)}.${change.kind}`, row, patch, source))
      return undefined;
    return new PolicyDenied({
      table: String(change.table),
      key: String(change.key),
      op: change.kind,
      message: `${change.kind} on ${String(change.table)} denied`,
    });
  };
  /**
   * Locality is the schema's, decided from what the transaction turned out to touch: wholly on
   * `local` tables, the event never leaves this device. A transaction that mixes local and
   * synced tables gets no flag, so its local change fails validation (`LocalOnly`) and the
   * whole transaction rolls back — one event cannot both travel and stay.
   */
  const mutateOptionsFor = (options: WriteOptions, captured: readonly Change[]) => {
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
        { peerId: engine.peerId, changes: captured, ...mutateOptionsFor(options, captured) },
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

  const write: Write = Object.assign(
    (label: WriteLabel, fn: () => Promise<void>, options: WriteOptions = {}) =>
      Result.gen(async function* () {
        const captureOptions = { check: judge(options) };
        if (options.partition !== undefined)
          Object.assign(captureOptions, { partition: options.partition });
        const changes = yield* Result.await(captureChanges(driver, tables, fn, captureOptions));
        const name = label instanceof Function ? label(changes) : label;
        if (changes.length === 0) {
          return Result.err(
            new EmptyMutation({ procedure: procedure(name), message: `${name} changed nothing` }),
          );
        }
        const mutateOptions = mutateOptionsFor(options, changes);
        const recorded =
          deps.operations !== undefined && !("local" in mutateOptions)
            ? { store: deps.operations, id: options.operationId ?? crypto.randomUUID() }
            : undefined;
        if (recorded !== undefined)
          Object.assign(mutateOptions, {
            record: async (event: SyncEvent) => {
              const row = {
                id: recorded.id,
                peer: event.peerId,
                seq: event.seqNum,
                label: name,
                atMs: (deps.now?.() ?? Temporal.Now.instant()).epochMilliseconds,
                // the write's own stamp, so a row can find this record by what it already carries
                hlcMs: event.hlc[0].epochMilliseconds,
                hlcLogical: Number(event.hlc[1]),
              };
              (await recorded.store.record(row)).unwrap();
            },
          });
        const event = yield* Result.await(
          engine.mutate(procedure(name), (tx) => replay(tx, changes), mutateOptions),
        );
        const receipt = { eventId: event.id };
        if (recorded !== undefined) Object.assign(receipt, { operationId: recorded.id });
        return Result.ok(receipt);
      }),
    { rehearse },
  );
  return write;
}

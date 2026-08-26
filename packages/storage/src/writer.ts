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
import type { Change, EventId, PartitionKey, Procedure } from "@syncmesh/kernel";
import type { Table } from "@syncmesh/schema";

import { EmptyMutation, PolicyDenied, can } from "@syncmesh/engine";
import { getRecord, readRow } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { SqlDriver } from "./driver.js";

import { captureChanges } from "./capture.js";

/** One committed transaction: the event it appended, for `delivered` and `revert`. */
export interface TxReceipt {
  readonly eventId: EventId;
}

/**
 * D20's write path: the app writes its tables with its own SQL; this turns that transaction into
 * one signed event. The schema and policy verdict runs inside the transaction, before COMMIT, so a
 * refused write never reaches the table — the same ladder every receiving peer runs.
 */

export interface WriteOptions {
  /** The instance the transaction's rows belong to; every change of one event shares it. */
  readonly partition?: PartitionKey;
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
}

/** The event's procedure label: given, or derived from what the transaction turned out to change. */
export type WriteLabel = string | ((changes: readonly Change[]) => string);

export type Write = (
  label: WriteLabel,
  fn: () => Promise<void>,
  options?: WriteOptions,
) => Promise<Result<TxReceipt, WriteError>>;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- procedures are `table.op` labels (E09) */
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
  /** The actor's verdict on one change — the same AST the device's own validator runs, for another principal. */
  const actorDenies = (change: Change): PolicyDenied | undefined => {
    if (actor === undefined || schema === undefined) return undefined;
    const row = before.row(change.table, change.key);
    const patch =
      change.kind === "insert" ? change.row : change.kind === "update" ? change.patch : undefined;
    if (can(schema, actor, `${String(change.table)}.${change.kind}`, row, patch)) return undefined;
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
  return (label, fn, options = {}) =>
    Result.gen(async function* () {
      const captureOptions = {
        check: (captured: readonly Change[]) => {
          if (captured.length === 0) return Result.ok(undefined);
          const denied = captured.map(actorDenies).find((d) => d !== undefined);
          if (denied !== undefined) return Result.err(denied);
          return validate.validate(
            { peerId: engine.peerId, changes: captured, ...mutateOptionsFor(options, captured) },
            before,
          );
        },
      };
      if (options.partition !== undefined)
        Object.assign(captureOptions, { partition: options.partition });
      const changes = yield* Result.await(captureChanges(driver, tables, fn, captureOptions));
      const name = label instanceof Function ? label(changes) : label;
      if (changes.length === 0) {
        return Result.err(
          new EmptyMutation({ procedure: procedure(name), message: `${name} changed nothing` }),
        );
      }
      const event = yield* Result.await(
        engine.mutate(
          procedure(name),
          (tx) => replay(tx, changes),
          mutateOptionsFor(options, changes),
        ),
      );
      return Result.ok({ eventId: event.id });
    });
}

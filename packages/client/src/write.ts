import type {
  Engine,
  MutateError,
  StateLookup,
  StoreFailure,
  Tx,
  Validator,
} from "@syncmesh/engine";
import type { Change, PartitionKey, Procedure } from "@syncmesh/kernel";
import type { Table } from "@syncmesh/schema";
import type { SqliteDriver } from "@syncmesh/storage";

import { EmptyMutation } from "@syncmesh/engine";
import { getRecord, readRow } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { captureChanges } from "@syncmesh/storage";

import type { TxReceipt } from "./views.js";

/**
 * D20's write path: the app writes its tables with its own SQL; this turns that transaction into
 * one signed event. The schema and policy verdict runs inside the transaction, before COMMIT, so a
 * refused write never reaches the table — the same ladder every receiving peer runs.
 */

export interface WriteOptions {
  /** The instance the transaction's rows belong to; every change of one event shares it. */
  readonly partition?: PartitionKey;
  /** Never leaves this device. */
  readonly local?: boolean;
}

export type WriteError = MutateError | StoreFailure;

export interface WriterDeps {
  readonly engine: Engine;
  readonly validate: Validator;
  /** The connection the app's tables live on; capture is installed on it. */
  readonly driver: SqliteDriver;
  readonly tables: readonly Table[];
}

export type Write = (
  label: string,
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
  const { engine, validate, driver, tables } = deps;
  const before: StateLookup = {
    row: (table, key) => readRow(engine.state(), table, key),
    partition: (table, key) => getRecord(engine.state(), table, key)?.partition,
  };
  return (label, fn, options = {}) =>
    Result.gen(async function* () {
      const mutateOptions = {};
      if (options.partition !== undefined)
        Object.assign(mutateOptions, { partition: options.partition });
      if (options.local === true) Object.assign(mutateOptions, { local: true });
      const captureOptions = {
        check: (captured: readonly Change[]) =>
          captured.length === 0
            ? Result.ok(undefined)
            : validate.validate(
                { peerId: engine.peerId, changes: captured, ...mutateOptions },
                before,
              ),
      };
      if (options.partition !== undefined)
        Object.assign(captureOptions, { partition: options.partition });
      const changes = yield* Result.await(captureChanges(driver, tables, fn, captureOptions));
      if (changes.length === 0) {
        return Result.err(
          new EmptyMutation({ procedure: procedure(label), message: `${label} changed nothing` }),
        );
      }
      const event = yield* Result.await(
        engine.mutate(procedure(label), (tx) => replay(tx, changes), mutateOptions),
      );
      return Result.ok({ eventId: event.id });
    });
}

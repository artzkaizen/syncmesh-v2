import type { Engine, Tx } from "@syncmesh/engine";
import type { Change, PartitionKey, Procedure, RowKey, TableName } from "@syncmesh/kernel";

import { getRecord, isVisible } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { CaptureError } from "./errors.js";
import type { HeldRows, PlannedEvent } from "./plan.js";
import type { Watermark } from "./source.js";

import { EventRefused } from "./errors.js";
import { CDC_TABLE, watermarkCells, watermarkKey } from "./watermark.js";

export interface ApplyDeps {
  readonly engine: Engine;
  /** The source's name: the `_cdc` row's key, and what a refusal is reported against. */
  readonly source: string;
  readonly procedure: Procedure;
}

const applyChange = (tx: Tx, change: Change): void => {
  if (change.kind === "insert") tx.insert(change.table, change.key, change.row);
  else if (change.kind === "update") tx.update(change.table, change.key, change.patch);
  else tx.delete(change.table, change.key);
};

/**
 * One transaction as one signed event per partition, with the watermark riding the **last** of
 * them — the same commit, which is the whole durability argument.
 *
 * Ordering is the argument, so it is worth stating. Events go out in partition order and the
 * watermark is a change inside the final one, so a crash anywhere in here leaves the stored
 * watermark behind the transaction rather than ahead of it. The next start replays the whole
 * transaction: the partitions already written get the same values again under later stamps,
 * which field-level LWW joins to the same rows, and the partitions that never landed get their
 * first copy. Replay is the failure we choose. The other one — a watermark ahead of an event
 * that does not exist — loses a change that nothing can re-request.
 *
 * `carry` is `null` while a backfill is still running: a watermark stored halfway through would
 * skip every row not yet read, because the stream starts *after* it and those rows may never
 * change again.
 */
export async function applyPlan(
  deps: ApplyDeps,
  events: readonly PlannedEvent[],
  carry: Watermark | null,
): Promise<Result<number, CaptureError>> {
  for (const planned of events) {
    const written = await deps.engine.mutate(
      deps.procedure,
      (tx) => {
        for (const change of planned.changes) applyChange(tx, change);
      },
      { partition: planned.partition },
    );
    if (written.isErr()) {
      return Result.err(
        new EventRefused({
          source: deps.source,
          partition: planned.partition,
          cause: written.error,
          message: `${deps.source}: ${planned.partition} refused the change: ${written.error.message}`,
        }),
      );
    }
  }
  // the watermark rides no partition and no change: it is one row about the source, and pinning
  // it to whichever instance a transaction happened to touch last would make its partition a
  // function of fold order — two peers with the same events disagreeing on it permanently, with
  // repair unable to heal it because `partition` is first-seen-wins and is hashed into the digest.
  // A separate last event costs one event and keeps the durability argument exactly: the position
  // still lands strictly after every change it covers, so it can only ever be behind, never ahead
  if (carry !== null) {
    const marked = await writeWatermark(deps, carry);
    if (marked.isErr()) return marked;
  }
  return Result.ok(events.length);
}

/**
 * The watermark with no change to ride: what closes a backfill, where the inserts are already
 * durable in their own events and only the position is left to record. Written with no
 * partition, because a position is about the source and not about any one instance.
 */
export async function writeWatermark(
  deps: ApplyDeps,
  at: Watermark,
): Promise<Result<void, CaptureError>> {
  const written = await deps.engine.mutate(deps.procedure, (tx) =>
    tx.insert(CDC_TABLE, watermarkKey(deps.source), watermarkCells(deps.source, at)),
  );
  if (written.isErr()) {
    return Result.err(
      new EventRefused({
        source: deps.source,
        partition: "",
        cause: written.error,
        message: `${deps.source}: the watermark was refused: ${written.error.message}`,
      }),
    );
  }
  return Result.ok(undefined);
}

/** What the plan needs to read out of the engine: where a row lives, and which rows are live. */
export const heldRows = (engine: Engine): HeldRows => ({
  partitionOf: (table: TableName, key: RowKey): PartitionKey | undefined => {
    const record = getRecord(engine.state(), table, key);
    return record !== undefined && isVisible(record) ? record.partition : undefined;
  },
  liveKeys: (table: TableName): readonly RowKey[] =>
    [...(engine.state().get(table) ?? [])]
      .filter(([, record]) => isVisible(record))
      .map(([key]) => key),
});

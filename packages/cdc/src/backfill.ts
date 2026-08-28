import { Result } from "@syncmesh/result";

import type { ApplyDeps } from "./apply.js";
import type { CaptureError } from "./errors.js";
import type { PlanDeps } from "./plan.js";
import type { ChangeMessage, TableRead, Watermark } from "./source.js";

import { applyPlan, writeWatermark } from "./apply.js";
import { SourceFailed } from "./errors.js";
import { planTransaction } from "./plan.js";

export interface BackfillDeps {
  readonly apply: ApplyDeps;
  readonly plan: PlanDeps;
  readonly read: TableRead;
  /** Rows per event batch; a backfill of a large table is many events, never one. */
  readonly batch: number;
}

/**
 * The first sync of a source that has never been read: current state as inserts, then a stream
 * that starts where the read did. It is RFC-0019's scoped snapshot with a different producer,
 * and the ordering is the whole of it.
 *
 * **The watermark is captured before the first row is read, and stored after the last one.**
 * Captured after, a row written during the read appears in neither the snapshot nor the stream
 * and is lost. Stored early, a crash halfway leaves the stream resuming past rows that were
 * never inserted and may never change again. Captured first and stored last, the only failure
 * left is that a crash replays the whole backfill — the same values under later stamps, which
 * converge.
 */
export async function runBackfill(deps: BackfillDeps): Promise<Result<Watermark, CaptureError>> {
  const source = deps.apply.source;
  const failed = (cause: unknown, message: string) =>
    Result.err<Watermark, CaptureError>(new SourceFailed({ source, message, cause }));
  const captured = await Result.tryPromise({
    try: () => deps.read.watermark(),
    catch: (cause) => failed(cause, `${source}: the backfill could not capture a watermark`).error,
  });
  if (captured.isErr()) return Result.err(captured.error);
  const at = captured.value;

  for (const table of Object.keys(deps.plan.mappings)) {
    const read = await Result.tryPromise({
      try: () => readTable(deps, table),
      catch: (cause) => failed(cause, `${source}: the backfill of ${table} failed`).error,
    });
    const written = read.andThen((rows) => rows);
    if (written.isErr()) return Result.err(written.error);
  }

  const stored = await writeWatermark(deps.apply, at);
  return stored.isErr() ? Result.err(stored.error) : Result.ok(at);
}

/**
 * One table's rows, in batches. Every exit is a value; reading itself failing is the source
 * breaking, which {@link runBackfill} converts rather than this.
 */
async function readTable(deps: BackfillDeps, table: string): Promise<Result<void, CaptureError>> {
  let batch: ChangeMessage[] = [];
  const flush = async () => {
    const written = await writeBatch(deps, batch);
    batch = [];
    return written;
  };
  for await (const row of deps.read.rows(table)) {
    batch.push({ t: "insert", table, row });
    if (batch.length < deps.batch) continue;
    const written = await flush();
    if (written.isErr()) return Result.err(written.error);
  }
  const written = await flush();
  return written.isErr() ? Result.err(written.error) : Result.ok(undefined);
}

/** One batch as events, carrying no watermark: the position is only true once every row is in. */
async function writeBatch(
  deps: BackfillDeps,
  batch: readonly ChangeMessage[],
): Promise<Result<number, CaptureError>> {
  if (batch.length === 0) return Result.ok(0);
  const planned = planTransaction(deps.plan, batch);
  if (planned.isErr()) return Result.err(planned.error);
  return applyPlan(deps.apply, planned.value, null);
}

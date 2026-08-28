import type { Engine } from "@syncmesh/engine";
import type { Procedure } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { ApplyDeps } from "./apply.js";
import type { CaptureError } from "./errors.js";
import type { ChangeMappings } from "./mapping.js";
import type { PlanDeps } from "./plan.js";
import type { ChangeMessage, ChangeSource, ChangeStream, TableRead, Watermark } from "./source.js";

import { applyPlan, heldRows } from "./apply.js";
import { runBackfill } from "./backfill.js";
import { SchemaDrift, SourceFailed } from "./errors.js";
import { planTransaction } from "./plan.js";
import { storedWatermark } from "./watermark.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- this bridge's own procedure names, fixed by this module */
const APPLY = "_cdc.apply" as Procedure;
const BACKFILL = "_cdc.backfill" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export interface CaptureOptions {
  /** The authority's engine: it signs every event CDC produces and holds the whole projection. */
  readonly engine: Engine;
  readonly source: ChangeSource;
  readonly mappings: ChangeMappings;
  /** How many rows one `truncate` may tombstone. Absent, `truncate` is refused outright. */
  readonly truncateLimit?: number;
  /** Where current state comes from when this source has no watermark yet. Absent, none is read. */
  readonly backfill?: TableRead;
  /** Rows per backfill event. Default 500. */
  readonly batch?: number;
  /** What the events are written under. Default `_cdc.apply`. */
  readonly procedure?: Procedure;
}

export interface CaptureReport {
  readonly transactions: number;
  readonly events: number;
  /** Where the log now says this source was read to; `null` if nothing was ever written. */
  readonly watermark: Watermark | null;
}

export interface RunningCapture {
  /** Resolves when the loop ends — after `stop()`, or with the failure that ended it. */
  readonly done: Promise<Result<CaptureReport, CaptureError>>;
  readonly stop: () => void;
}

/**
 * The bridge: a database's committed transactions as signed events, one per partition touched.
 *
 * It resumes from the `_cdc` row rather than from anything the source remembers, backfills when
 * that row is absent and a reader was given, and acks a watermark only once the events derived
 * from it are in the event store. Every failure stops the loop without acking, so the position
 * stays behind the work and a restart replays rather than skips.
 *
 * ```ts
 * const running = (await startCapture({ engine, source, mappings })).unwrap()
 * // ... later
 * running.stop()
 * const report = (await running.done).unwrap()
 * ```
 */
export async function startCapture(
  options: CaptureOptions,
): Promise<Result<RunningCapture, CaptureError>> {
  const source = options.source.name;
  const apply: ApplyDeps = {
    engine: options.engine,
    source,
    procedure: options.procedure ?? APPLY,
  };
  const plan: PlanDeps =
    options.truncateLimit === undefined
      ? { mappings: options.mappings, held: heldRows(options.engine) }
      : {
          mappings: options.mappings,
          held: heldRows(options.engine),
          truncateLimit: options.truncateLimit,
        };

  let after = storedWatermark(options.engine, source);
  if (after === null && options.backfill !== undefined) {
    const filled = await runBackfill({
      apply: { ...apply, procedure: BACKFILL },
      plan,
      read: options.backfill,
      batch: options.batch ?? 500,
    });
    if (filled.isErr()) return Result.err(filled.error);
    after = filled.value;
  }

  const opened = await open(options.source, after);
  if (opened.isErr()) return Result.err(opened.error);
  const stream = opened.value;
  const stopping = { asked: false };
  return Result.ok({
    done: run({ apply, plan, stream, stopping }, after),
    stop: () => {
      stopping.asked = true;
      stream.stop();
    },
  });
}

async function open(
  source: ChangeSource,
  after: Watermark | null,
): Promise<Result<ChangeStream, CaptureError>> {
  try {
    return Result.ok(await source.start({ after }));
  } catch (cause) {
    return Result.err(
      new SourceFailed({
        source: source.name,
        message: `${source.name}: the stream would not open`,
        cause,
      }),
    );
  }
}

interface LoopDeps {
  readonly apply: ApplyDeps;
  readonly plan: PlanDeps;
  readonly stream: ChangeStream;
  readonly stopping: { asked: boolean };
}

/**
 * `begin` … `commit` is the event boundary, so the loop is: buffer, plan, write, then ack.
 *
 * The ack is last and it is unconditional, which needs saying. A commit that touched no
 * published table plans no events, so nothing carries its watermark into the log — and acking
 * it anyway loses nothing, because a resume from the older stored watermark reaches the same
 * state by definition: every transaction between the two produced no change, and planning is a
 * pure function of the messages and the state, so it produces none on the replay either.
 */
async function run(
  deps: LoopDeps,
  from: Watermark | null,
): Promise<Result<CaptureReport, CaptureError>> {
  let buffered: ChangeMessage[] = [];
  let transactions = 0;
  let events = 0;
  let watermark = from;
  try {
    for await (const message of deps.stream.changes) {
      if (deps.stopping.asked) break;
      if (message.t === "schema") {
        return Result.err(
          new SchemaDrift({
            source: deps.apply.source,
            table: message.table,
            detail: message.detail,
            message: `${message.table} changed shape in the database: ${message.detail}`,
          }),
        );
      }
      if (message.t === "begin") {
        buffered = [];
        continue;
      }
      if (message.t !== "commit") {
        buffered.push(message);
        continue;
      }
      const planned = planTransaction(deps.plan, buffered);
      if (planned.isErr()) return Result.err(planned.error);
      const written = await applyPlan(deps.apply, planned.value, message.watermark);
      if (written.isErr()) return Result.err(written.error);
      buffered = [];
      transactions += 1;
      events += written.value;
      if (written.value > 0) watermark = message.watermark;
      deps.stream.ack(message.watermark);
    }
  } catch (cause) {
    return Result.err(
      new SourceFailed({
        source: deps.apply.source,
        message: `${deps.apply.source}: the stream failed`,
        cause,
      }),
    );
  } finally {
    deps.stream.stop();
  }
  return Result.ok({ transactions, events, watermark });
}

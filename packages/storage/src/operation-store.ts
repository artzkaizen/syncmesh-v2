import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";

import { StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";

import type { SqlDriver, SqlRow } from "./driver.js";

import { dialectOf, namespaceDdl } from "./dialect.js";
import { attempt } from "./sql.js";

/* oxlint-disable anti-slop/no-runtime-typeof -- decoding SQL rows *is* this file's I/O boundary: the driver hands back positional SqlValues, and the checks here are the parse that restores the row's contract */

/**
 * The write's durable record (book ch. 10): allocated before commit, written in the same
 * transaction as the event, read back after any crash — a caller looks an ambiguous outcome up
 * here instead of retrying into a duplicate. Receipts are the replication half: one row per
 * peer whose acknowledged cursors cover the event. A receipt is delivery, never approval.
 */

/** Where the write stands on this device. `blocked` arrives with recovery (Phase 2). */
export type OperationOutcome = "applied" | "blocked" | "superseded";

export interface OperationRow {
  readonly id: string;
  /** The event the write became — its author and sequence. */
  readonly peer: PeerId;
  readonly seq: SeqNum;
  readonly label: string;
  readonly atMs: number;
  /** The write's own stamp, so a row can find its operation by the stamp it already carries. */
  readonly hlcMs?: number;
  readonly hlcLogical?: number;
  readonly status: OperationOutcome;
  /** Set when an authority overwrote this write's values, and why (ch. 20). */
  readonly correction?: { readonly by: string; readonly reason: string };
}

export interface ReceiptRow {
  readonly holder: PeerId;
  readonly atMs: number;
}

export interface OperationStore {
  /**
   * One row for a committed write. Runs plain statements on the shared connection, so calling
   * it inside the engine's `atomic` puts the record in the same transaction as the append.
   */
  readonly record: (
    op: Omit<OperationRow, "status" | "correction">,
  ) => Promise<ResultType<void, StoreFailure>>;
  readonly get: (id: string) => Promise<ResultType<OperationRow | undefined, StoreFailure>>;
  readonly byEvent: (
    peer: PeerId,
    seq: SeqNum,
  ) => Promise<ResultType<OperationRow | undefined, StoreFailure>>;
  /** Every operation no peer has receipted yet, oldest first. */
  readonly unsettled: () => Promise<ResultType<readonly OperationRow[], StoreFailure>>;
  /** Receipts for every operation `holder`'s acknowledged cursor now covers — idempotent. */
  readonly acknowledge: (
    holder: PeerId,
    author: PeerId,
    throughSeq: SeqNum,
    atMs: number,
  ) => Promise<ResultType<void, StoreFailure>>;
  readonly receiptsOf: (
    peer: PeerId,
    seq: SeqNum,
  ) => Promise<ResultType<readonly ReceiptRow[], StoreFailure>>;
  /** Marks the displaced write superseded and remembers why (ch. 20). */
  readonly correct: (
    peer: PeerId,
    seq: SeqNum,
    by: string,
    reason: string,
  ) => Promise<ResultType<void, StoreFailure>>;
}

const decodeOp = (row: SqlRow): ResultType<OperationRow, StoreFailure> => {
  const [id, peer, seq, label, atMs, status, correctedBy, correctedReason] = row;
  if (typeof id !== "string" || typeof peer !== "string" || typeof label !== "string")
    return Result.err(new StoreFailure({ message: "operation row does not decode" }));
  if (status !== "applied" && status !== "blocked" && status !== "superseded")
    return Result.err(new StoreFailure({ message: `unknown operation status ${String(status)}` }));
  // SAFETY: peer and seq were written from a PeerId and SeqNum by this store's own insert
  const base: OperationRow = {
    id,
    peer: peer as PeerId,
    seq: Number(seq) as SeqNum,
    label,
    atMs: Number(atMs),
    status,
  };
  if (typeof correctedBy === "string" && typeof correctedReason === "string")
    return Result.ok({ ...base, correction: { by: correctedBy, reason: correctedReason } });
  return Result.ok(base);
};

/**
 * Opens (and creates, idempotently) the operation and receipt tables on this connection.
 *
 * @example
 * const operations = (await operationStore(driver)).unwrap();
 */
export function operationStore(
  driver: SqlDriver,
): Promise<ResultType<OperationStore, StoreFailure>> {
  const sql = dialectOf(driver).operations;
  return Result.gen(async function* () {
    yield* Result.await(
      attempt("operation tables failed to open", async () => {
        for (const statement of namespaceDdl(driver.dialect ?? "sqlite"))
          await driver.run(statement);
        for (const statement of sql.ddl) await driver.run(statement);
      }),
    );
    const rows = (query: string, params: readonly (string | number)[]) =>
      attempt("operation store read failed", () => driver.all(query, params));
    const store: OperationStore = {
      record: (op) =>
        attempt("operation record failed", () =>
          driver.run(sql.insertOp, [
            op.id,
            String(op.peer),
            Number(op.seq),
            op.label,
            op.atMs,
            op.hlcMs ?? 0,
            op.hlcLogical ?? 0,
            "applied",
          ]),
        ),
      get: (id) =>
        Result.gen(async function* () {
          const [row] = yield* Result.await(rows(sql.selectOp, [id]));
          return row === undefined ? Result.ok(undefined) : decodeOp(row);
        }),
      byEvent: (peer, seq) =>
        Result.gen(async function* () {
          const [row] = yield* Result.await(rows(sql.selectOpByEvent, [String(peer), Number(seq)]));
          return row === undefined ? Result.ok(undefined) : decodeOp(row);
        }),
      unsettled: () =>
        Result.gen(async function* () {
          const held = yield* Result.await(rows(sql.selectUnsettled, []));
          return Result.all(held.map(decodeOp));
        }),
      acknowledge: (holder, author, throughSeq, atMs) =>
        attempt("receipt insert failed", () =>
          driver.run(sql.insertReceiptsThrough, [
            String(holder),
            atMs,
            String(author),
            Number(throughSeq),
          ]),
        ),
      receiptsOf: (peer, seq) =>
        Result.gen(async function* () {
          const held = yield* Result.await(rows(sql.selectReceipts, [String(peer), Number(seq)]));
          return Result.all(
            held.map(([holder, atMs]) => {
              if (typeof holder !== "string")
                return Result.err(new StoreFailure({ message: "receipt row does not decode" }));
              // SAFETY: holder was written from a PeerId by acknowledge
              return Result.ok({ holder: holder as PeerId, atMs: Number(atMs) });
            }),
          );
        }),
      correct: (peer, seq, by, reason) =>
        attempt("correction mark failed", () =>
          driver.run(sql.markCorrected, [by, reason, String(peer), Number(seq)]),
        ),
    };
    return Result.ok(store);
  });
}
/* oxlint-enable anti-slop/no-runtime-typeof */

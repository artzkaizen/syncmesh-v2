import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { QuarantineReason } from "@syncmesh/wire";

import { StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { isQuarantineReason } from "@syncmesh/wire";

import type { SqlRow, SqlValue } from "./driver.js";
import type { OperationRow } from "./operation-store.js";

/* oxlint-disable anti-slop/no-runtime-typeof -- decoding SQL rows is this file's I/O boundary: the checks are the parse */

/**
 * One peer's signed verdict on one write (D32). `reason` is what a screen branches on:
 * `unknown-table` and `unknown-kind` mean the refuser is **on an older build** and cannot read the
 * write yet, never that it said no; only `refused` is the ladder's no.
 */
export interface OperationRefusal {
  /** The refuser's peer id; weigh by who, never by how many. */
  readonly by: PeerId;
  readonly reason: QuarantineReason;
  /** The `ValidationError` tag — `GrantStale`, `PolicyDenied`, … — never prose. */
  readonly verdict: string;
}

export interface RefusalRow extends Omit<OperationRefusal, "by"> {
  readonly refuser: PeerId;
  /** When the refuser signed it, by the refuser's clock (its `issuedAt`), not when it arrived here. */
  readonly atMs: number;
}

const decodeRefusal = ([refuser, reason, verdict, atMs]: SqlRow): ResultType<
  RefusalRow,
  StoreFailure
> => {
  if (
    typeof refuser !== "string" ||
    typeof reason !== "string" ||
    typeof verdict !== "string" ||
    !isQuarantineReason(reason)
  )
    return Result.err(new StoreFailure({ message: "refusal row does not decode" }));
  // SAFETY: refuser was written from a PeerId by `refuse`
  return Result.ok({ refuser: refuser as PeerId, reason, verdict, atMs: Number(atMs) });
};

/** The row with its refusals beside it, or the row unchanged when nobody refused it. */
const withRefusals = (row: OperationRow, refusals: readonly RefusalRow[]): OperationRow =>
  refusals.length === 0
    ? row
    : {
        ...row,
        refusals: refusals.map(({ refuser, reason, verdict }) => ({
          by: refuser,
          reason,
          verdict,
        })),
      };

/** One `(peer, seq)` as a map key; both halves are what the ledger's own rows hold. */
const eventKey = (peer: SqlValue | undefined, seq: SqlValue | undefined): string =>
  [peer, seq].join("-");

/** The ledger's reads of the refusals table (D32), and the operation rows they decorate. */
export function createRefusalReads(deps: {
  readonly rows: (
    query: string,
    params: readonly (string | number)[],
  ) => Promise<ResultType<readonly SqlRow[], StoreFailure>>;
  readonly decodeOp: (row: SqlRow) => ResultType<OperationRow, StoreFailure>;
  readonly selectRefusals: string;
  readonly selectAllRefusals: string;
}) {
  const { rows, decodeOp } = deps;
  const refusalsAt = (peer: PeerId, seq: SeqNum) =>
    Result.gen(async function* () {
      const held = yield* Result.await(rows(deps.selectRefusals, [peer, seq]));
      return Result.all(held.map(decodeRefusal));
    });
  /** One decoded row, with whoever refused it. */
  const refused = (row: SqlRow) =>
    Result.gen(async function* () {
      const op = yield* decodeOp(row);
      return Result.ok(withRefusals(op, yield* Result.await(refusalsAt(op.peer, op.seq))));
    });
  /** Many decoded rows, with one read of the refusals table rather than one per row. */
  const allRefused = (held: readonly SqlRow[]) =>
    Result.gen(async function* () {
      const ops = yield* Result.all(held.map(decodeOp));
      if (ops.length === 0) return Result.ok(ops);
      const all = yield* Result.await(rows(deps.selectAllRefusals, []));
      const byEvent = new Map<string, RefusalRow[]>();
      for (const [peer, seq, ...rest] of all) {
        const row = yield* decodeRefusal(rest);
        byEvent.set(eventKey(peer, seq), [...(byEvent.get(eventKey(peer, seq)) ?? []), row]);
      }
      return Result.ok(
        ops.map((op) => withRefusals(op, byEvent.get(eventKey(op.peer, op.seq)) ?? [])),
      );
    });
  return { refusalsAt, refused, allRefused };
}
/* oxlint-enable anti-slop/no-runtime-typeof */

import type { StoreFailure } from "@syncmesh/engine";
import type { EventId, PeerId, SeqNum } from "@syncmesh/kernel";

import { eventId, parseEventId, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { SqlDriver, SqlRow } from "./driver.js";

import { attempt, failure } from "./sql.js";

/** A `(peer, seq, local)` row back to the id of the event it keys. */
const heldId = ([peer, seq, local]: SqlRow): Result<EventId, StoreFailure> =>
  Result.gen(function* () {
    const peerId = yield* parsePeerId(String(peer)).mapError(failure("stored peer id is invalid"));
    const seqNum = yield* parseSeqNum(Number(seq)).mapError(failure("stored sequence is invalid"));
    return Result.ok(eventId(peerId, seqNum, Number(local) === 1));
  });

/**
 * `EventStore.holding` over a SQL log: which of a list of events it holds, in one statement
 * (`EventSql.selectHeld`) however long the list.
 */
export const createHolding =
  (driver: SqlDriver, selectHeld: string) =>
  (ids: readonly EventId[]): Promise<Result<ReadonlySet<EventId>, StoreFailure>> =>
    Result.gen(async function* () {
      const parsed = yield* Result.all(ids.map(parseEventId)).mapError(
        failure("malformed event id"),
      );
      const wanted = parsed.map(({ peerId, seqNum, local }) => ({
        peer: peerId,
        seq: seqNum,
        local: local ? 1 : 0,
      }));
      if (wanted.length === 0) return Result.ok(new Set<EventId>());
      const rows = yield* Result.await(
        attempt("holding failed", () => driver.all(selectHeld, [JSON.stringify(wanted)])),
      );
      return Result.all(rows.map(heldId)).map((held) => new Set(held));
    });

/** A row of the log read for its place in its author's run, decoded only if it is wanted. */
export interface Placed {
  readonly event: { readonly peerId: PeerId; readonly seqNum: SeqNum; readonly local: boolean };
  readonly partition: string | null;
  readonly row: SqlRow;
}

/**
 * `(core, local, sig, peer, seq, partition)` rows as places in their authors' runs, cores left
 * encoded: what a filtered read checks for holes before it decodes the events it keeps.
 */
export const parsePlaced = (rows: readonly SqlRow[]): Result<readonly Placed[], StoreFailure> =>
  Result.all(
    rows.map((row) =>
      Result.gen(function* () {
        const [, local, , peer, seq, partition] = row;
        const peerId = yield* parsePeerId(String(peer)).mapError(
          failure("stored peer id is invalid"),
        );
        const seqNum = yield* parseSeqNum(Number(seq)).mapError(
          failure("stored sequence is invalid"),
        );
        const at = { peerId, seqNum, local: Number(local) === 1 };
        return Result.ok({
          event: at,
          partition: partition === null ? null : String(partition),
          row,
        });
      }),
    ),
  );

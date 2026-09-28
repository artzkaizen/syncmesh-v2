import type { Mesh } from "@syncmesh/client";
import type { StoreFailure, StrandedWrites } from "@syncmesh/engine";
import type { Result as ResultType } from "@syncmesh/result";

import { Temporal } from "@syncmesh/temporal";

import type { DevtoolsStranded, DevtoolsWrites } from "../contract.js";

/**
 * The write ledger, bounded by the caller.
 *
 * `unsettled()` is a `LEFT JOIN` with no `LIMIT` behind it, which is fine for the question it was
 * written to answer — *is anything stuck* — and wrong for a panel that renders every row it is
 * handed. So the limit lives here, and `truncated` comes back beside the rows: a list that quietly
 * stopped at fifty will be read as "fifty writes are waiting", which is a different sentence.
 *
 * Oldest first, unchanged from the store, because the write that has waited longest is the one
 * worth explaining and a newest-first ledger buries it under everything that has worked since.
 *
 * What this cannot show is what *succeeded*. A settled operation is unreachable unless the caller
 * already knows its id, so this is a list of what is stuck rather than a history — and a panel
 * that implied otherwise would read an idle mesh as a broken one.
 */

export type WritesReader = (limit: number) => Promise<ResultType<DevtoolsWrites, StoreFailure>>;

export function createWritesReader(ledger: NonNullable<Mesh["operations"]>): WritesReader {
  return async (limit) => {
    const held = await ledger.unsettled();
    return held.map((rows) => ({
      unsettled: rows.slice(0, limit).map((row) => ({
        id: row.id,
        label: row.label,
        peer: row.peer,
        seq: row.seq,
        at: Temporal.Instant.fromEpochMilliseconds(row.atMs),
        status: row.status,
        correctedBy: row.correction?.by,
        correctedReason: row.correction?.reason,
      })),
      truncated: rows.length > limit,
    }));
  };
}

/**
 * The engine's stranded reports as rows.
 *
 * Beside the ledger because it answers the ledger's own question one step further on: `unsettled`
 * is *nobody has confirmed holding this yet*, and this is *nobody ever will*. It reads the engine
 * rather than the operations store, because a stranded run is a fact about the log — the
 * operation records beside it may well have been compacted away, and the run would still be
 * stuck.
 *
 * The fields are copied out rather than the error passed along: `StrandedWrites` is a class, a
 * class does not cross a port, and a panel wants a row.
 */
export const strandedRows = (reports: readonly StrandedWrites[]): readonly DevtoolsStranded[] =>
  reports.map(({ author, count, from, to, message }) => ({ author, count, from, to, message }));

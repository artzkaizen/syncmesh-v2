import type { Mesh } from "@syncmesh/client";
import type { EventHeader, StoreFailure } from "@syncmesh/engine";
import type { EventId, PeerId } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";

import type { DevtoolsEvent } from "../contract.js";

/**
 * The log's tail, with this device's own writes named.
 *
 * **Why the log cannot name them itself.** A header is deliberately the shape of an event and
 * never its contents: naming the tables a stored event wrote means decoding the core its author
 * signed, which is the one cost the header exists to avoid and which a panel refreshing on every
 * fold would pay per row. So an events panel over a SQL-backed store — that is, over every real
 * device — shows a page of authors, sequences and byte counts, and cannot say what a single one
 * of them *was*.
 *
 * For this device's own writes it does not have to decode anything, because it wrote them: the
 * operation ledger already holds a row per write, keyed by the event it became, carrying the
 * procedure that made it. That is a `SELECT` by primary key against a table in the same database,
 * and it turns half a page of opaque rows into `issues.move`.
 *
 * **Another peer's events stay unnamed, and that is correct rather than a gap.** The ledger is a
 * record of what *this* device did; it holds nothing about a write that arrived from somewhere
 * else, and the only way to name one of those is the decode this panel refuses. A reader is shown
 * the difference instead of a blank that means two things.
 */

/** One header as a panel reads it, and a memo so a label is looked up once per event, ever. */
export type LabelReader = (headers: readonly EventHeader[]) => Promise<readonly DevtoolsEvent[]>;

/**
 * Labels are immutable — a write is recorded once, under the name it ran as — so an event asked
 * about is never asked about again. Without the memo a panel that repaints on every fold would
 * re-read the same hundred rows for the life of the session.
 */
export function createLabelReader(ledger: Mesh["operations"], self: PeerId): LabelReader {
  const known = new Map<EventId, string | undefined>();

  const ask = async (header: EventHeader): Promise<string | undefined> => {
    if (ledger === undefined) return undefined;
    const found: ResultType<{ readonly label: string } | undefined, StoreFailure> =
      await ledger.byEvent(header.peer, header.seq);
    // a refusal is not a finding here: the header is still worth drawing, and the ledger's own
    // panel is where a broken connection gets said out loud
    return found.isOk() ? found.value?.label : undefined;
  };

  return async (headers) => {
    const mine = headers.filter((h) => h.peer === self && !known.has(h.id));
    const asked = await Promise.all(mine.map(async (h) => [h.id, await ask(h)] as const));
    for (const [id, label] of asked) known.set(id, label);
    return headers.map((header) => ({ ...header, label: known.get(header.id) }));
  };
}

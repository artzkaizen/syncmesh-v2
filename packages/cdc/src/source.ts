import type { Brand, CellValue, Ordering } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

/**
 * The seam a change source is (RFC-0021): a resumable stream of one database's committed
 * transactions, and an ack channel back. Postgres logical replication, SQLite triggers over an
 * outbox, or an app that calls us when it writes — every one of them is these two types, for
 * the reason `BlobStore` and `SqlDriver` are two types: a port stays short or it stops being a
 * port.
 *
 * Direction is fixed and that is the whole design. A table is either the database's, and
 * reaches devices through here as a signed read-only projection, or it is the mesh's, where the
 * local commit is the truth. Never both — a mirror between two writers is the drift this exists
 * to refuse, and writes travel the other way as a procedure (D10). The cost, stated plainly: a
 * CDC-backed table is not offline-writable, because an offline write against a database we do
 * not own is a promise we cannot keep.
 *
 * `manualChangeSource` is the only source shipped. **Postgres logical replication is follow-on
 * work, deliberately not started**: it is a slot, a `pgoutput` decoder and a keepalive protocol
 * behind this same seam, and a half-built one would be a source that acks what it has not
 * decoded — the one failure the port exists to make impossible. Everything above it — the
 * transaction fold, the watermark, the backfill, the alarms — is already written against the
 * port and needs nothing from it but these two types.
 */

/**
 * Where a source got to, in its own terms: a Postgres LSN, an outbox row id, a counter. Opaque
 * to us but for one property — **lexicographic order is stream order** — which is the only
 * thing that lets a resume say "after this one" without knowing what the source means by it.
 */
export type Watermark = Brand<string, "Watermark">;

export class InvalidWatermark extends TaggedError("InvalidWatermark")<{
  input: string;
  message: string;
}> {}

/**
 * A watermark from its text. The empty string is refused rather than read as "the beginning":
 * `null` already means that, and a value sorting before every other one would quietly rewind a
 * source to a full replay on the first restart after whatever produced it went wrong.
 */
export function parseWatermark(input: string): Result<Watermark, InvalidWatermark> {
  if (input.length === 0) {
    return Result.err(
      new InvalidWatermark({ input, message: "a watermark is never empty; the beginning is null" }),
    );
  }
  // SAFETY: matched the one invariant a watermark has — non-empty
  return Result.ok(input as Watermark);
}

/** Stream order, which for a watermark is lexicographic order — the port's one assumption. */
export const compareWatermark = (a: Watermark, b: Watermark): Ordering =>
  a < b ? -1 : a > b ? 1 : 0;

/** One row as the database sent it: its own column names, its own values, nothing checked yet. */
export type SourceRow = Readonly<Record<string, CellValue>>;

/**
 * Transaction-framed, because that framing is already our event boundary (D1): everything
 * between `begin` and `commit` is one committed transaction, and one committed transaction
 * becomes one signed event per partition it touched.
 */
export type ChangeMessage =
  | { readonly t: "begin" }
  /** No key: it is the primary-key column of the collection this table feeds, and nowhere else. */
  | { readonly t: "insert"; readonly table: string; readonly row: SourceRow }
  /** The whole row after the write, so a replay of it says the same thing as the first pass. */
  | {
      readonly t: "update";
      readonly table: string;
      readonly key: string;
      readonly after: SourceRow;
    }
  | { readonly t: "delete"; readonly table: string; readonly key: string }
  /** Table-wide, and expensive: it becomes one tombstone per row this peer holds. Capped. */
  | { readonly t: "truncate"; readonly table: string }
  /**
   * The database changed its own shape. Carried so a source can *report* it, never so we apply
   * it: our schema is a frozen wire artifact (RFC-0013), so a column that appeared in Postgres
   * is not a column in the mesh until `collections` says so and ships. This is an **alarm**,
   * not an instruction, and the bridge stops on it rather than guessing what it meant.
   */
  | { readonly t: "schema"; readonly table: string; readonly detail: string }
  | { readonly t: "commit"; readonly watermark: Watermark };

export interface ChangeStream {
  readonly changes: AsyncIterable<ChangeMessage>;
  /**
   * This watermark's changes are durable here; the source may forget them. Called **only** once
   * the derived events are in the event store — ack first and a crash loses a change with
   * nothing left that could re-request it, the same defect as a transport that resolves `send`
   * on a frame it dropped (RFC-0005).
   */
  readonly ack: (watermark: Watermark) => void;
  readonly stop: () => void;
}

export interface ChangeSource {
  /** Names the `_cdc` row this source's watermark is filed under; a slot has one reader, so one name. */
  readonly name: string;
  /** Resumes after `after`, or from the source's own beginning when it is `null`. */
  readonly start: (options: { readonly after: Watermark | null }) => Promise<ChangeStream>;
}

/**
 * Every row of one table as the database holds it *now*, for the first sync of a source that
 * has no watermark yet — RFC-0019's scoped snapshot with a different producer.
 *
 * `watermark()` is read **before** the first row is, so the stream resumes at a point the read
 * already covers. The other order leaves a hole: a row written between the read and the capture
 * appears in neither.
 */
export interface TableRead {
  readonly watermark: () => Promise<Watermark>;
  readonly rows: (table: string) => AsyncIterable<SourceRow>;
}

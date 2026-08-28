import type { MutateError } from "@syncmesh/engine";
import type { RowError } from "@syncmesh/schema";

import { TaggedError } from "@syncmesh/result";

import type { InvalidWatermark } from "./source.js";

/**
 * Every one of these ends the capture loop without acking, which is the point: the watermark
 * stays where it was, and whatever went unwritten is replayed on the next start rather than
 * lost. A source that cannot be read is a stopped bridge, never a partial one.
 */

/**
 * The database changed its own shape and told us. An alarm, not an instruction (RFC-0013): the
 * mesh's schema is signed and versioned, so a column that appeared in Postgres is not a column
 * here until `collections` names it and the app ships. Stopping is the honest answer — applying
 * it would forge a schema nobody signed, and ignoring it would drift silently.
 */
export class SchemaDrift extends TaggedError("SchemaDrift")<{
  source: string;
  table: string;
  detail: string;
  message: string;
}> {}

/**
 * A `truncate` that would emit more tombstones than the cap allows, or one on a bridge that
 * never opted in. A truncate is a partition-scoped delete of everything, so on a large table it
 * is a million-row event; the cap is the difference between a loud refusal and a mesh that
 * spends a day replicating one careless statement.
 */
export class TruncateRefused extends TaggedError("TruncateRefused")<{
  table: string;
  rows: number;
  limit: number;
  message: string;
}> {}

/**
 * A row nothing could place: the mapping's `partition` returned nothing for it, or returned
 * something that is not a `kind:id`. Refused rather than skipped — a dropped row is a database
 * and a mesh that disagree forever, which is exactly what CDC exists to prevent.
 */
export class RowUnplaceable extends TaggedError("RowUnplaceable")<{
  table: string;
  key: string;
  message: string;
}> {}

/** A source row that is not a row of the collection it feeds: a missing key, a wrong kind. */
export class RowUnreadable extends TaggedError("RowUnreadable")<{
  table: string;
  cause: RowError;
  message: string;
}> {}

/**
 * The engine refused the event, or could not store it. Carries the verdict as itself, because
 * `PolicyDenied` on a CDC collection means something specific: the rules do not let the
 * authority write the table it is supposed to be projecting.
 */
export class EventRefused extends TaggedError("EventRefused")<{
  source: string;
  partition: string;
  cause: MutateError;
  message: string;
}> {}

/** The stream itself failed — the connection dropped, the iterator threw. Recoverable: restart. */
export class SourceFailed extends TaggedError("SourceFailed")<{
  source: string;
  message: string;
  cause: unknown;
}> {}

export type CaptureError =
  | SchemaDrift
  | TruncateRefused
  | RowUnplaceable
  | RowUnreadable
  | EventRefused
  | SourceFailed
  | InvalidWatermark;

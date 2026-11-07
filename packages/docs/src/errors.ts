import { TaggedError } from "@syncmesh/result";

/** The column names an adapter this runtime was not given (RFC-0023 §10): it folds, but cannot open. */
export class AdapterMissing extends TaggedError("AdapterMissing")<{
  adapter: string;
  message: string;
}> {}

/** The mesh declares no document column by that name on that table. */
export class NotADocColumn extends TaggedError("NotADocColumn")<{
  table: string;
  column: string;
  message: string;
}> {}

/** A flush's update is past `limits.maxUpdateBytes`; the handle is invalidated, its ops never sent. */
export class UpdateTooLarge extends TaggedError("UpdateTooLarge")<{
  size: number;
  limit: number;
  message: string;
}> {}

/** The document's snapshot is past `limits.maxSnapshotBytes`. */
export class DocTooLarge extends TaggedError("DocTooLarge")<{
  size: number;
  limit: number;
  message: string;
}> {}

/**
 * The document holds operations that wait on others this device does not have yet — a blob not
 * fetched, an event not received — so a snapshot of it would leave them out. It is materialised
 * once they land.
 */
export class DocPending extends TaggedError("DocPending")<{
  message: string;
}> {}

/** The engine refused the flush — policy, validation or the store; the handle is invalidated. */
export class FlushRefused extends TaggedError("FlushRefused")<{
  message: string;
  cause?: unknown;
}> {}

/** A handle used after its lineage moved, a refused flush, or its last close. */
export class HandleInvalidated extends TaggedError("HandleInvalidated")<{ message: string }> {}

/**
 * A checkpoint that cannot be installed: unsigned by the producer named, of an adapter or lineage
 * this document is not on, whose snapshot bytes are not the ones it names, or whose snapshot does
 * not reproduce the version it claims (RFC-0023 §7.3).
 */
export class CheckpointRefused extends TaggedError("CheckpointRefused")<{
  message: string;
  cause?: unknown;
}> {}

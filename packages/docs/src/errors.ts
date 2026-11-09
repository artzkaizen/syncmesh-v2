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

/**
 * A blob-carried update could not be put (RFC-0023 §5.4, D18): the blob store refused the bytes,
 * so the burst was not sent and the handle is invalidated.
 */
export class BlobUnavailable extends TaggedError("BlobUnavailable")<{
  message: string;
  cause?: unknown;
}> {}

/** One write both edited and replaced the document at this address; nothing was written. */
export class DocWriteConflict extends TaggedError("DocWriteConflict")<{
  table: string;
  key: string;
  column: string;
  message: string;
}> {}

/**
 * A lineage `restore()` would bring back only part of (RFC-0023 §5.3): updates of it this device
 * can no longer read — their events compacted with no snapshot of it left, history it never
 * received — or blob-carried ones no carrier holds yet. Nothing was written. Updates the adapter
 * cannot read are not counted: a restore leaves them out, as every replica does.
 */
export class LineageIncomplete extends TaggedError("LineageIncomplete")<{
  lost: number;
  missing: number;
  message: string;
}> {}

/**
 * A checkpoint of a sealed partition's document was asked of a device that holds no content key
 * for the partition: its snapshot would have gone to the host in the clear (RFC-0023 §11).
 */
export class SnapshotUnsealable extends TaggedError("SnapshotUnsealable")<{
  partition: string;
  message: string;
}> {}

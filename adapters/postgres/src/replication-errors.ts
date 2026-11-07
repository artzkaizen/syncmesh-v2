import { TaggedError } from "@syncmesh/result";

/** The publication this source reads does not exist; `publish()` creates it. */
export class PublicationMissing extends TaggedError("PublicationMissing")<{
  publication: string;
  message: string;
}> {}

/**
 * Another connection is reading the slot, or the slot is still active and cannot be dropped. A
 * slot has one reader; two authorities on one slot would double-sign every change.
 */
export class SlotBusy extends TaggedError("SlotBusy")<{
  slot: string;
  message: string;
  cause?: unknown;
}> {}

/**
 * The server discarded WAL the slot still needed (`wal_status = lost`, usually
 * `max_slot_wal_keep_size`). What it held is gone and nothing can replay it: drop the slot and
 * backfill again.
 */
export class SlotLost extends TaggedError("SlotLost")<{ slot: string; message: string }> {}

/** A slot of this name exists for another output plugin or another database. */
export class SlotMismatch extends TaggedError("SlotMismatch")<{
  slot: string;
  message: string;
}> {}

/**
 * A change or a backfilled table this source cannot key: no replica identity or primary key, or
 * one spanning several columns.
 */
export class UnkeyedChange extends TaggedError("UnkeyedChange")<{
  table: string;
  message: string;
}> {}

/** A query or the replication connection failed, after every reconnect it was allowed. */
export class ReplicationFailed extends TaggedError("ReplicationFailed")<{
  slot: string;
  message: string;
  cause: unknown;
}> {}

export type PostgresSourceError =
  | PublicationMissing
  | SlotBusy
  | SlotLost
  | SlotMismatch
  | UnkeyedChange
  | ReplicationFailed;

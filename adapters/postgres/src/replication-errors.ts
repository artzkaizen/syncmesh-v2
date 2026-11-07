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
 * The slot cannot replay what a resume asks for: the server discarded WAL it still needed
 * (`wal_status = lost`, usually `max_slot_wal_keep_size`), or a start from a stored position
 * found no slot at all (dropped, or a restore or failover that did not carry it). What it held is
 * gone: drop the slot, forget the stored position and backfill again.
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

/**
 * A row's key changed under `REPLICA IDENTITY DEFAULT` while it held a TOASTed value the update
 * left alone. Postgres sends that value as "unchanged" and the old row carries only the key, so
 * the row cannot be inserted under its new key whole. `REPLICA IDENTITY FULL` sends the old row
 * in full; changes already in the slot stay unreadable, so set it, drop the slot and backfill.
 */
export class PartialKeyChange extends TaggedError("PartialKeyChange")<{
  table: string;
  /** The columns the change did not carry. */
  columns: readonly string[];
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
  | PartialKeyChange
  | ReplicationFailed;

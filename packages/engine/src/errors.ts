import type { EventId, PeerId, Procedure } from "@syncmesh/kernel";
import type { RowError } from "@syncmesh/schema";

import { TaggedError } from "@syncmesh/result";

import type { QuarantineEvicted, UnreadableEvent } from "./quarantine.js";
import type { StoreFailure } from "./store.js";
import type { StrandedWrites } from "./stranded.js";

export class EmptyMutation extends TaggedError("EmptyMutation")<{
  procedure: Procedure;
  message: string;
}> {}

export class CannotRevert extends TaggedError("CannotRevert")<{
  eventId: EventId;
  message: string;
}> {}

/** Nothing persists state, so the log is its only copy and nothing may be removed from it. */
export class CompactionRefused extends TaggedError("CompactionRefused")<{ message: string }> {}

export class ListenerFailure extends TaggedError("ListenerFailure")<{
  hook: "onFoldBatch" | "onOutbound" | "onAcknowledge";
  message: string;
  cause: unknown;
}> {}

export type MutateError = EmptyMutation | ValidationError | StoreFailure;

export type RevertError = CannotRevert | MutateError;

/**
 * Reported through `onError`: a listener threw, the state cache refused a commit, the quarantine
 * dropped an event it was holding, or the log was found holding writes nobody here can send —
 * the things that go wrong beside a call rather than inside one, so no caller is standing there
 * to be handed a `Result`.
 */
export type EngineError =
  | ListenerFailure
  | StoreFailure
  | QuarantineEvicted
  | UnreadableEvent
  | StrandedWrites;

export class NoGrant extends TaggedError("NoGrant")<{ peer: PeerId; message: string }> {}
export class GrantDeviceMismatch extends TaggedError("GrantDeviceMismatch")<{
  peer: PeerId;
  device: PeerId;
  message: string;
}> {}
export class GrantRevoked extends TaggedError("GrantRevoked")<{
  peer: PeerId;
  partition: string;
  message: string;
}> {}
/**
 * The grant is unexpired but too old for the instance being written to, which set a grace window
 * (RFC-0016). Its own tag and not `NoGrant`: "renew and try again" is a different thing to put in
 * front of a person than "we do not know who you are", and only one of them is recoverable.
 */
export class GrantStale extends TaggedError("GrantStale")<{
  peer: PeerId;
  expiresAt: string;
  message: string;
}> {}
/** Which of `checkLink`'s rungs a `_links` row failed; the cheap ones run before the signature. */
export type LinkRung = "key" | "isolation" | "author" | "monotonic" | "columns" | "signature";

/**
 * A `_links` row nobody should fold, and the rung that says why (D21). One tag for all six,
 * because every one of them has the same remedy — none. A link is a claim two keys make
 * together, so a row that fails any rung is not a weaker claim, it is not that claim at all.
 */
export class LinkRefused extends TaggedError("LinkRefused")<{
  /** The row it was filed under: `instance:device`. */
  key: string;
  rung: LinkRung;
  message: string;
}> {}
export class UnknownTable extends TaggedError("UnknownTable")<{ table: string; message: string }> {}
/**
 * A change kind the kernel here has no fold for — a newer build's change arriving at an older
 * one (D13). Its own tag and not `SchemaViolation`: this is the refusal an upgrade is expected
 * to reverse, so it has to be distinguishable from the refusals that no upgrade will.
 */
export class UnknownChangeKind extends TaggedError("UnknownChangeKind")<{
  table: string;
  kind: string;
  message: string;
}> {}
export class PartitionNotGranted extends TaggedError("PartitionNotGranted")<{
  table: string;
  partition: string;
  message: string;
}> {}
export class WrongPartition extends TaggedError("WrongPartition")<{
  table: string;
  expected: string;
  message: string;
}> {}
export class LocalOnly extends TaggedError("LocalOnly")<{ table: string; message: string }> {}
export class ReadOnlyPartition extends TaggedError("ReadOnlyPartition")<{
  table: string;
  message: string;
}> {}
export class SchemaViolation extends TaggedError("SchemaViolation")<{
  table: string;
  key: string;
  cause: RowError;
  message: string;
}> {}
/**
 * Which rule a doc change broke (RFC-0023 §10, §11). Every one is decided from the schema and the
 * event alone, so every peer at one schema version parks the same set.
 *
 * - `column` — the column is declared, but not as a document.
 * - `adapter` — the change names another adapter than the column declares.
 * - `lineage` — a genesis that names no lineage, one that is not the derivation of where it sits,
 *   or two geneses for one document in one event.
 * - `local` — a doc change in a local event; documents live on synced rows.
 */
export type DocRung = "column" | "adapter" | "lineage" | "local";

/** A doc change nobody should fold, and the rung that says why. */
export class DocChangeRefused extends TaggedError("DocChangeRefused")<{
  table: string;
  key: string;
  column: string;
  rung: DocRung;
  message: string;
}> {}

/**
 * A row write naming a document column (RFC-0023 §6.4). The column's cell is the lineage cell and
 * its SQL column the materialised snapshot; neither is a value a row write may set, and letting one
 * through would have a row rule join a cell only the lineage rule may.
 */
export class DocColumnWrite extends TaggedError("DocColumnWrite")<{
  table: string;
  key: string;
  column: string;
  message: string;
}> {}

export class PolicyDenied extends TaggedError("PolicyDenied")<{
  table: string;
  key: string;
  op: string;
  message: string;
}> {}
/**
 * The stamp runs further ahead of this device's clock than the drift bound allows (D34). Not a
 * forgery verdict — a phone with its clock set wrong writes exactly this — but a stamp admitted
 * as it stands would win every `lww` cell it touches and drag every receiver's clock after it.
 * Parked rather than dropped: the author's cursor stops below it, and a retry admits it once
 * the wall clock has caught up with the claim.
 */
export class ClockAhead extends TaggedError("ClockAhead")<{
  peer: PeerId;
  /** The stamp's instant, ISO. */
  at: string;
  /** The latest instant this device would have believed when it looked, ISO. */
  limit: string;
  message: string;
}> {}

/** Why an event is refused, in ladder order: clock → grant → device → revocation → grace → partition → schema → policy; a reserved row also answers to its table's author class. */
export type ValidationError =
  | ClockAhead
  | NoGrant
  | LinkRefused
  | UnknownChangeKind
  | GrantDeviceMismatch
  | GrantRevoked
  | GrantStale
  | UnknownTable
  | PartitionNotGranted
  | WrongPartition
  | LocalOnly
  | ReadOnlyPartition
  | SchemaViolation
  | DocChangeRefused
  | DocColumnWrite
  | PolicyDenied;

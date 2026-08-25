import type { EventId, PeerId, Procedure } from "@syncmesh/kernel";
import type { RowError } from "@syncmesh/schema";

import { TaggedError } from "@syncmesh/result";

import type { StoreFailure } from "./store.js";

export class EmptyMutation extends TaggedError("EmptyMutation")<{
  procedure: Procedure;
  message: string;
}> {}

export class CannotRevert extends TaggedError("CannotRevert")<{
  eventId: EventId;
  message: string;
}> {}

export class ListenerFailure extends TaggedError("ListenerFailure")<{
  hook: "onFoldBatch" | "onOutbound";
  message: string;
  cause: unknown;
}> {}

export type MutateError = EmptyMutation | ValidationError | StoreFailure;

export type RevertError = CannotRevert | MutateError;

export type EngineError = ListenerFailure;

export class NoGrant extends TaggedError("NoGrant")<{ peer: PeerId; message: string }> {}
export class GrantDeviceMismatch extends TaggedError("GrantDeviceMismatch")<{
  peer: PeerId;
  device: PeerId;
  message: string;
}> {}
export class UnknownTable extends TaggedError("UnknownTable")<{ table: string; message: string }> {}
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
export class PolicyDenied extends TaggedError("PolicyDenied")<{
  table: string;
  key: string;
  op: string;
  message: string;
}> {}

/** Why an event is refused, in ladder order: grant → device → partition → schema → policy. */
export type ValidationError =
  | NoGrant
  | GrantDeviceMismatch
  | UnknownTable
  | PartitionNotGranted
  | WrongPartition
  | LocalOnly
  | ReadOnlyPartition
  | SchemaViolation
  | PolicyDenied;

import type { EventId, Procedure } from "@syncmesh/kernel";

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

export type MutateError = EmptyMutation | StoreFailure;

export type RevertError = CannotRevert | MutateError;

export type EngineError = ListenerFailure;

import type { MutateError, RevertError } from "@syncmesh/engine";
import type { RowError } from "@syncmesh/schema";

import { TaggedError } from "@syncmesh/result";

/** The table lives in a declared kind and nothing is active for it; `activate` names the instance. */
export class NoActivePartition extends TaggedError("NoActivePartition")<{
  kind: string;
  message: string;
}> {}

/** `activate` was given an instance of a kind the manifest does not declare. */
export class UnknownPartitionKind extends TaggedError("UnknownPartitionKind")<{
  kind: string;
  message: string;
}> {}

export class NoSuchRow extends TaggedError("NoSuchRow")<{
  table: string;
  key: string;
  message: string;
}> {}

/** A `tx` touched tables that resolve to different instances; refused before anything is written. */
export class CrossPartitionTx extends TaggedError("CrossPartitionTx")<{
  partitions: readonly string[];
  message: string;
}> {}

export type WriteError = RowError | NoActivePartition | NoSuchRow | MutateError;

export type TxError = WriteError | CrossPartitionTx;

export type MeshRevertError = RevertError;

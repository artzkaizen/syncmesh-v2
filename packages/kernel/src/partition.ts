import { Result, TaggedError } from "@syncmesh/result";

import type { Brand } from "./primitives.js";

/** `kind:id` — the one form a partition instance takes, on events, on rows and in grants alike (D07). */
export type PartitionKey = Brand<string, "PartitionKey">;

export class InvalidPartitionKey extends TaggedError("InvalidPartitionKey")<{
  input: string;
  message: string;
}> {}

export const PARTITION_KEY = /^[a-z][a-z0-9_]{0,63}:[^\s:]{1,255}$/;

export function parsePartitionKey(input: string): Result<PartitionKey, InvalidPartitionKey> {
  if (!PARTITION_KEY.test(input)) {
    return Result.err(new InvalidPartitionKey({ input, message: "expected kind:id" }));
  }
  // SAFETY: matched PARTITION_KEY
  return Result.ok(input as PartitionKey);
}

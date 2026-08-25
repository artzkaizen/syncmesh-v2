import type { ColumnName, TableName } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

export class InvalidName extends TaggedError("InvalidName")<{ input: string; message: string }> {}

/** Table names: lowercase letters, digits, underscores; a leading `_` is reserved for the manifest's own tables. */
export const TABLE_IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;
/** Column names: camelCase, as the frozen vectors use (`updatedAt`). */
export const COLUMN_IDENTIFIER = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const RESERVED = /^_[a-z0-9_]{0,63}$/;

export function parseTableName(input: string): Result<TableName, InvalidName> {
  if (!TABLE_IDENTIFIER.test(input))
    return Result.err(
      new InvalidName({
        input,
        message: "table names are lowercase identifiers; `_` prefixes are reserved",
      }),
    );
  // SAFETY: matched TABLE_IDENTIFIER
  return Result.ok(input as TableName);
}

/** The manifest's own tables (`_policy`, `_corrections`) — never available to `table()`. */
export function reservedTableName(input: string): Result<TableName, InvalidName> {
  if (!RESERVED.test(input))
    return Result.err(new InvalidName({ input, message: "reserved table names start with `_`" }));
  // SAFETY: matched RESERVED
  return Result.ok(input as TableName);
}

export function parseColumnName(input: string): Result<ColumnName, InvalidName> {
  if (!COLUMN_IDENTIFIER.test(input))
    return Result.err(
      new InvalidName({ input, message: "column names are camelCase identifiers" }),
    );
  // SAFETY: matched COLUMN_IDENTIFIER
  return Result.ok(input as ColumnName);
}

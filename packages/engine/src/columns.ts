import type { Change, Row } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { checkRow, type Table, type WireRow } from "@syncmesh/schema";

import { SchemaViolation, UnknownChangeKind, type ValidationError } from "./errors.js";

/** The change kinds this build can fold. A kernel that grows one grows this set with it. */
const FOLDABLE = new Set(["insert", "update", "delete"]);

/**
 * The kind of a change this build has no fold for, or `undefined` when it can take it. A newer
 * peer's change kind reaches an older one as a value outside the union the types describe, which
 * is exactly the case D13 asks the older peer to park rather than crash on.
 */
export const unfoldableKind = (change: Change): string | undefined =>
  FOLDABLE.has(change.kind) ? undefined : String(change.kind);

/**
 * The cells a table declares, with every other key dropped.
 *
 * Dropping rather than refusing is the additive rule's second clause (D13): a column added by a
 * newer build must reach an older one as a cell it ignores, or the two builds hold different
 * rows and their digests never agree again. The cell is only dropped from the **check** — the
 * fold stores the change as it arrived, so both builds keep the same record and the read side
 * shows whichever columns its own schema names.
 */
const declared = (table: Table, cells: Row): WireRow =>
  Object.fromEntries([...cells].filter(([name]) => String(name) in table.columns));

/**
 * A change against the table it names: a kind this build can fold, and cells that pass the
 * columns it knows about.
 */
export function checkColumns(table: Table, change: Change): Result<void, ValidationError> {
  const kind = unfoldableKind(change);
  if (kind !== undefined) {
    return Result.err(
      new UnknownChangeKind({
        table: String(table.name),
        kind,
        message: `${String(table.name)}: this build has no fold for a ${kind} change`,
      }),
    );
  }
  if (change.kind === "delete") return Result.ok(undefined);
  const values = declared(table, change.kind === "insert" ? change.row : change.patch);
  const r = checkRow(table, values, change.kind);
  return r.isErr()
    ? Result.err(
        new SchemaViolation({
          table: String(table.name),
          key: String(change.key),
          cause: r.error,
          message: r.error.message,
        }),
      )
    : Result.ok(undefined);
}

import type { AdapterId, Change, ColumnName, FoldableChange, Row } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { checkRow, type Table, type WireRow } from "@syncmesh/schema";

import {
  DocColumnWrite,
  SchemaViolation,
  UnknownChangeKind,
  type ValidationError,
} from "./errors.js";

/** The change kinds this build can fold. A kernel that grows one grows this set with it. */
const FOLDABLE = new Set(["insert", "update", "delete", "doc"]);

/**
 * Whether this build can fold the change — and, because it narrows, the only way to reach the
 * fields a fold reads. A change that fails this is a newer peer's, kept whole and parked (D22-A).
 */
export const foldable = (change: Change): change is FoldableChange => FOLDABLE.has(change.kind);

/**
 * The kind of a change this build has no fold for, or `undefined` when it can take it. A newer
 * peer's change kind reaches an older one as `unknown` carrying the tag it was written under,
 * which is exactly the case D13 asks the older peer to park rather than crash on.
 */
export const unfoldableKind = (change: Change): string | undefined =>
  foldable(change) ? undefined : `${change.kind}(${change.tag})`;

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

/** A table's doc columns and the adapter each declares; empty for a table without any. */
export type TableDocs = ReadonlyMap<ColumnName, AdapterId>;

const NO_DOCS: TableDocs = new Map();

/**
 * A change against the table it names: a kind this build can fold, cells that pass the columns it
 * knows about, and no row write to a document column. A doc change's own rules are `checkDoc`'s,
 * since they need the event it sits in.
 */
export function checkColumns(
  table: Table,
  change: Change,
  docs: TableDocs = NO_DOCS,
): Result<void, ValidationError> {
  if (!foldable(change)) {
    const kind = unfoldableKind(change) ?? change.kind;
    return Result.err(
      new UnknownChangeKind({
        table: String(table.name),
        kind,
        message: `${String(table.name)}: this build has no fold for a ${kind} change`,
      }),
    );
  }
  if (change.kind === "delete" || change.kind === "doc") return Result.ok(undefined);
  const cells = change.kind === "insert" ? change.row : change.patch;
  for (const column of cells.keys()) {
    if (!docs.has(column)) continue;
    return Result.err(
      new DocColumnWrite({
        table: String(table.name),
        key: String(change.key),
        column: String(column),
        message: `${String(table.name)}.${String(column)} is a document: it is opened and edited, never written as a value`,
      }),
    );
  }
  const r = checkRow(table, declared(table, cells), change.kind);
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

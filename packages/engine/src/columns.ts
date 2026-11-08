import type { AdapterId, Change, ColumnName, FoldableChange, Row } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { checkRow, type Table, type WireRow } from "@syncmesh/schema";

import {
  DocColumnWrite,
  SchemaViolation,
  UnknownChangeKind,
  type ValidationError,
} from "./errors.js";
import { retiredWrite } from "./retired.js";

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
  Object.fromEntries([...cells].filter(([name]) => Object.hasOwn(table.columns, name)));

/** A table's doc columns and the adapter each declares; empty for a table without any. */
export type TableDocs = ReadonlyMap<ColumnName, AdapterId>;

const NO_DOCS: TableDocs = new Map();

/** Whether a table declares the column as derived (RFC-0023 §16.4). Own keys only: a cell named like an inherited property is a column this build does not name. */
const derivation = (table: Table, column: ColumnName) =>
  Object.hasOwn(table.columns, column) ? table.columns[column]?.def.derived : undefined;

/**
 * The document or derived column a row write names, if it names one: a derived column only on a
 * probe, since a numbered event's derived cell is dropped from the check instead.
 */
function docWrite(
  table: Table,
  key: FoldableChange["key"],
  cells: Row,
  docs: TableDocs,
  probe: boolean,
): DocColumnWrite | undefined {
  for (const column of cells.keys()) {
    const derived = probe ? derivation(table, column) : undefined;
    if (!docs.has(column) && derived === undefined) continue;
    return new DocColumnWrite({
      table: table.name,
      key,
      column,
      message:
        derived === undefined
          ? `${table.name}.${column} is a document: it is opened and edited, never written as a value`
          : `${table.name}.${column} is derived from ${derived.from}: every replica computes it, nothing writes it`,
    });
  }
  return undefined;
}

/**
 * A change against the table it names: a kind this build can fold, cells that pass the columns it
 * knows about, and no row write to a document column. A doc change's own rules are `checkDoc`'s,
 * since they need the event it sits in.
 *
 * A derived column and a retired one (D31) are refused only on a `probe` — this device's own
 * write, before it is numbered.
 * On a numbered event the cell is dropped from the check the way an undeclared one is: history
 * written before the column was derived, or by a build that does not derive it, still folds, and
 * the projection never copies the cell into the row (RFC-0023 §12).
 */
export function checkColumns(
  table: Table,
  change: Change,
  docs: TableDocs = NO_DOCS,
  probe = true,
): Result<void, ValidationError> {
  if (!foldable(change)) {
    const kind = unfoldableKind(change) ?? change.kind;
    return Result.err(
      new UnknownChangeKind({
        table: table.name,
        kind,
        message: `${table.name}: this build has no fold for a ${kind} change`,
      }),
    );
  }
  const retired = probe ? retiredWrite(table, change) : undefined;
  if (retired !== undefined) return Result.err(retired);
  if (change.kind === "delete" || change.kind === "doc") return Result.ok(undefined);
  const cells = change.kind === "insert" ? change.row : change.patch;
  const written = docWrite(table, change.key, cells, docs, probe);
  if (written !== undefined) return Result.err(written);
  const checked = new Map([...cells].filter(([name]) => derivation(table, name) === undefined));
  const r = checkRow(table, declared(table, checked), change.kind);
  return r.isErr()
    ? Result.err(
        new SchemaViolation({
          table: table.name,
          key: change.key,
          cause: r.error,
          message: r.error.message,
        }),
      )
    : Result.ok(undefined);
}

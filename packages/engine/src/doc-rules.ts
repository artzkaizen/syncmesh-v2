import type { Change, DocChange, DocColumns, Row } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { type Table } from "@syncmesh/schema";
import { deriveLineage } from "@syncmesh/wire";

import type { TableDocs } from "./columns.js";
import type { ProbeEvent } from "./validate.js";

import { checkColumns } from "./columns.js";
import { DocChangeRefused, type DocRung, type ValidationError } from "./errors.js";

const refuse = (change: DocChange, rung: DocRung, message: string) =>
  Result.err(
    new DocChangeRefused({
      table: String(change.table),
      key: String(change.key),
      column: String(change.column),
      rung,
      message,
    }),
  );

/**
 * One doc change against the schema and the event it sits in (RFC-0023 §10). Adapter-independent
 * by construction: nothing here asks what adapters this build holds, so a peer with one and a
 * peer without reach the same verdict on the same event.
 *
 * A column the table does not declare at all is let through, like any cell a newer build added
 * (D13's additive rule): refusing it would park at an old build what a new one folds. A column it
 * declares as something other than a document is refused, and so is a mismatched adapter.
 *
 * A genesis's lineage is checked only where the event is numbered. A probe has no sequence yet,
 * and the engine derives the lineage itself as it numbers the event.
 */
export function checkDoc(
  table: Table,
  docs: TableDocs,
  change: DocChange,
  event: ProbeEvent,
  index: number,
): Result<void, ValidationError> {
  if (event.local === true)
    return refuse(change, "local", "a document lives on a synced row, never in a local write");
  const declaredAdapter = docs.get(change.column);
  if (declaredAdapter === undefined && String(change.column) in table.columns)
    return refuse(change, "column", `${String(change.column)} is not a document column`);
  if (declaredAdapter !== undefined && declaredAdapter !== change.adapter)
    return refuse(
      change,
      "adapter",
      `${String(change.column)} is merged by ${declaredAdapter}, not ${change.adapter}`,
    );
  if (change.genesis !== true) return Result.ok(undefined);
  const twice = event.changes.some(
    (other, at) =>
      at !== index &&
      other.kind === "doc" &&
      other.genesis === true &&
      other.table === change.table &&
      other.key === change.key &&
      other.column === change.column,
  );
  if (twice) return refuse(change, "lineage", "one event starts one lineage per document");
  if (event.seqNum === undefined) return Result.ok(undefined);
  if (change.lineage === undefined) return refuse(change, "lineage", "a genesis names its lineage");
  const expected = deriveLineage(event.peerId, event.seqNum, index);
  return expected === change.lineage
    ? Result.ok(undefined)
    : refuse(change, "lineage", "the genesis names a lineage its place in the log does not derive");
}

const rowId = (change: Change): string => `${String(change.table)}\u0000${String(change.key)}`;

/**
 * A change's cells against its table (`checkColumns`), and a doc change against the rules only
 * a document has. `"settled"` when nothing is left for the policy rung to say: a doc change on a
 * row the same event inserts is judged as part of that insert (RFC-0023 §11).
 */
export function checkCells(
  table: Table,
  docs: DocColumns | undefined,
  change: Change,
  event: ProbeEvent,
  index: number,
): Result<"policy" | "settled", ValidationError> {
  const declared = docs?.get(change.table) ?? new Map();
  const columns = checkColumns(table, change, declared);
  if (columns.isErr()) return columns;
  if (change.kind !== "doc") return Result.ok("policy");
  const doc = checkDoc(table, declared, change, event, index);
  if (doc.isErr()) return doc;
  const inserts = event.changes.some((c) => c.kind === "insert" && rowId(c) === rowId(change));
  return Result.ok(inserts ? "settled" : "policy");
}

/**
 * What the policy rung sees a change write: an insert's row, an update's patch, and for a doc
 * change a patch naming only its column — to the ladder a doc change is an `update` of its row,
 * and what a rule can say about it is who may edit the row, never what the bytes say (§11).
 */
export const policyPatch = (change: Change): Row | undefined => {
  if (change.kind === "insert") return change.row;
  if (change.kind === "update") return change.patch;
  if (change.kind === "doc") return new Map([[change.column, null]]);
  return undefined;
};

/** The manifest's own tables hold no documents. */
export const refuseReservedDoc = (table: string, change: DocChange) =>
  Result.err(
    new DocChangeRefused({
      table,
      key: String(change.key),
      column: String(change.column),
      rung: "column",
      message: `${table} has no document columns`,
    }),
  );

import type { Change, DocChange, DocColumns, Row } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { type Table } from "@syncmesh/schema";
import { deriveLineage } from "@syncmesh/wire";

import type { TableDocs } from "./columns.js";
import type { ProbeEvent, RowLookup } from "./validate.js";

import { checkColumns } from "./columns.js";
import { DocChangeRefused, type DocRung, type ValidationError } from "./errors.js";

const refuse = (change: DocChange, rung: DocRung, message: string) =>
  Result.err(
    new DocChangeRefused({
      table: change.table,
      key: change.key,
      column: change.column,
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
 *
 * A genesis's parent — the lineage it replaces (§16.1) — is never required to be held. Naming one
 * this peer has not seen yet is how out-of-order delivery looks, and the lineage walk resolves it
 * when the parent lands, so parking it would park at one peer what another folds. Only what the
 * event alone disproves is refused: a parent on an edit that is not a genesis, a genesis that
 * names its own lineage as the one it replaces, and a genesis written under the rule before §16.1
 * (`legacy`), which the wire keeps readable so this is where it stops.
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
  if (declaredAdapter === undefined && Object.hasOwn(table.columns, change.column))
    return refuse(change, "column", `${change.column} is not a document column`);
  if (declaredAdapter !== undefined && declaredAdapter !== change.adapter)
    return refuse(
      change,
      "adapter",
      `${change.column} is merged by ${declaredAdapter}, not ${change.adapter}`,
    );
  if (change.genesis !== true)
    return change.parent === undefined
      ? Result.ok(undefined)
      : refuse(change, "lineage", "only a genesis names the lineage it replaces");
  if (change.legacy === true)
    return refuse(
      change,
      "lineage",
      "a genesis written under the lineage rule before RFC-0023 §16.1 (key 5 `true`)",
    );
  if (change.parent !== undefined && change.parent === change.lineage)
    return refuse(change, "lineage", "a genesis cannot replace its own lineage");
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

const rowId = (change: Change): string => `${change.table}\u0000${change.key}`;

/**
 * A change's cells against its table (`checkColumns`), and a doc change against the rules only
 * a document has. `"settled"` when nothing is left for the policy rung to say: a doc change on a
 * row the same event inserts is judged as part of that insert (RFC-0023 §11). A row `before`
 * already holds is not being inserted, whatever the event says, so its doc change is still the
 * update of that row the policy rung judges.
 */
export function checkCells(
  table: Table,
  docs: DocColumns | undefined,
  change: Change,
  event: ProbeEvent,
  index: number,
  before: RowLookup,
): Result<"policy" | "settled", ValidationError> {
  const declared = docs?.get(change.table) ?? new Map();
  const columns = checkColumns(table, change, declared, event.seqNum === undefined);
  if (columns.isErr()) return columns;
  if (change.kind !== "doc") return Result.ok("policy");
  const doc = checkDoc(table, declared, change, event, index);
  if (doc.isErr()) return doc;
  if (before(change.table, change.key) !== undefined) return Result.ok("policy");
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
      key: change.key,
      column: change.column,
      rung: "column",
      message: `${table} has no document columns`,
    }),
  );

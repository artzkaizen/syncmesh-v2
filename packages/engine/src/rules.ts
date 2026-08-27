import type { ColumnName, PartitionKey, RowKey, TableName } from "@syncmesh/kernel";
import type { AllowBlock, PolicyDoc } from "@syncmesh/policy";

import { parsePolicyDoc } from "@syncmesh/policy";

import type { RowLookup } from "./validate.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the reserved policy table's own name and column */
const POLICY_TABLE = "_policy" as TableName;
const RULES_COLUMN = "rules" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** One parsed policy doc per `_policy` record, so a hot path re-parses nothing. */
const parsedDocs = new WeakMap<object, PolicyDoc>();

/**
 * The rules for one table as the `_policy` row for an instance states them, when one has
 * synced — permissions deploy by sync, so a change binds every device that holds the instance
 * without an app release. Absent or unparsable, the bundled manifest stands, which is what the
 * `?? entry.allow` at the call sites says.
 *
 * Enforcement and the UI's `can` both read it from here, so a doc can never bind one and not the
 * other: a button that lights up is a write that lands.
 */
export function syncedRules(
  table: TableName,
  partition: PartitionKey | undefined,
  rows: RowLookup,
): AllowBlock | undefined {
  if (partition === undefined) return undefined;
  // SAFETY: the `_policy` row for an instance is keyed by that instance's own key
  const record = rows(POLICY_TABLE, String(partition) as RowKey);
  if (record === undefined) return undefined;
  const rules = record.get(RULES_COLUMN);
  // a json column's cell is the doc itself; anything not an object was never a doc
  if (rules === null || rules === undefined || rules instanceof Uint8Array) return undefined;
  if (Array.isArray(rules) || !(rules instanceof Object)) return undefined;
  const held = parsedDocs.get(rules);
  const doc = held ?? parsePolicyDoc(rules).unwrapOr(undefined);
  if (doc === undefined) return undefined;
  if (held === undefined) parsedDocs.set(rules, doc);
  return doc[String(table)];
}

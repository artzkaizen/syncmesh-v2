import type { ColumnName, PartitionKey, Row, RowKey, TableName } from "@syncmesh/kernel";
import type { AllowBlock, PolicyDoc } from "@syncmesh/policy";

import { parsePolicyDoc } from "@syncmesh/policy";

import type { RowLookup } from "./validate.js";

import { moment } from "./authority.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the reserved policy table's own name and columns */
const POLICY_TABLE = "_policy" as TableName;
const RULES_COLUMN = "rules" as ColumnName;
const GRACE_COLUMN = "grace" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/**
 * The `_policy` record for one instance, as this device holds it. Both of what an instance owns —
 * its rules and its grace window — live in the one row, so they are looked up once here rather
 * than found twice from two places that could drift apart.
 */
function policyRow(partition: PartitionKey | undefined, rows: RowLookup): Row | undefined {
  if (partition === undefined) return undefined;
  // SAFETY: the `_policy` row for an instance is keyed by that instance's own key
  return rows(POLICY_TABLE, String(partition) as RowKey);
}

/**
 * How long before `expiresAt` this instance stops trusting a cached grant, in milliseconds;
 * `undefined` where it has said nothing, which is every instance until one does (RFC-0016).
 *
 * A strict instance sets it to force a device to have *renewed* recently rather than merely to
 * hold an unexpired grant — the containment for a device that went offline holding a long-lived
 * one. It is per-instance because strictness is: the same device, same grant, may be too stale
 * for the payroll org and current everywhere else.
 */
export function graceMillis(
  partition: PartitionKey | undefined,
  rows: RowLookup,
): number | undefined {
  const grace = policyRow(partition, rows)?.get(GRACE_COLUMN);
  if (grace === null || grace === undefined) return undefined;
  return moment(grace);
}

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
  const record = policyRow(partition, rows);
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

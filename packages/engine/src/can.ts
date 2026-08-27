import type { PartitionKey, Row } from "@syncmesh/kernel";

import { evaluate, resolveAllow, type Operation } from "@syncmesh/policy";

import { syncedRules } from "./rules.js";
import { policyContext, type Principal, type RowLookup, type ValidatorSchema } from "./validate.js";

/**
 * Where the rules that actually bind are found: the instance whose `_policy` row governs the
 * question, and the rows this device holds to read that row from.
 *
 * Withhold it and `can` answers from the bundled manifest alone. That is the honest answer for a
 * caller with no instance in hand — a global table, a question asked before anything has
 * synced — and a stale one for a caller that had an instance and did not say so: the authority
 * may have published a doc that overrules the bundle, and the write would then disagree.
 */
export interface PolicySource {
  readonly partition: PartitionKey;
  readonly rows: RowLookup;
}

/**
 * The UI's question, answered by the same rule the receivers enforce: `"table.op"` against a row,
 * for a principal — the device's grant, or an actor a server acts as. Given a `source`, the
 * instance's synced `_policy` doc is preferred over the bundled block exactly as validation
 * prefers it, so a button that lights up is a write that lands. A table with no rules at all is
 * readable by anyone who holds it and writable only where the kind itself says so.
 */
export function can(
  schema: ValidatorSchema,
  principal: Principal | undefined,
  what: `${string}.${string}`,
  row?: Row,
  patch?: Row,
  source?: PolicySource,
): boolean {
  const dot = what.indexOf(".");
  const table = what.slice(0, dot);
  const op: Operation = what.slice(dot + 1);
  const entry = schema.entries.find((e) => String(e.table.name) === table);
  if (entry === undefined || principal === undefined) return false;
  const synced =
    source === undefined ? undefined : syncedRules(entry.table.name, source.partition, source.rows);
  const rules = synced ?? entry.allow;
  if (rules === undefined)
    return op === "read" || entry.partition === "user" || entry.partition === "local";
  return evaluate(
    resolveAllow(rules, op),
    policyContext(principal, schema.rolesFor(entry.partition), row, patch),
  );
}

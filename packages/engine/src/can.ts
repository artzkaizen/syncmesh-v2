import type { PartitionKey, Row } from "@syncmesh/kernel";

import { evaluate, resolveAllow, type Operation, type PolicyContext } from "@syncmesh/policy";

import { explainRule, sourced, type PolicyWhy, type SourcedRules } from "./policy-why.js";
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

/** What answering takes once the table, the principal and the rules are known. */
type Resolved =
  | { readonly early: Exclude<PolicyWhy, { readonly rung: "policy" }> }
  | {
      readonly early?: undefined;
      readonly op: Operation;
      readonly rules: SourcedRules;
      readonly context: PolicyContext;
    };

/** The question resolved the way validation resolves it, up to the rule it is evaluated under. */
function resolveQuestion(
  schema: ValidatorSchema,
  principal: Principal | undefined,
  what: `${string}.${string}`,
  row: Row | undefined,
  patch: Row | undefined,
  source: PolicySource | undefined,
): Resolved {
  const dot = what.indexOf(".");
  const table = what.slice(0, dot);
  const op: Operation = what.slice(dot + 1);
  const entry = schema.entries.find((e) => String(e.table.name) === table);
  if (entry === undefined) return { early: { allowed: false, rung: "table" } };
  if (principal === undefined) return { early: { allowed: false, rung: "principal" } };
  const synced =
    source === undefined ? undefined : syncedRules(entry.table.name, source.partition, source.rows);
  const rules =
    synced === undefined ? sourced(entry.allow, "manifest") : sourced(synced, "policy-doc");
  if (rules === undefined) {
    const allowed = op === "read" || entry.partition === "user" || entry.partition === "local";
    return { early: { allowed, rung: "kind" } };
  }
  const context = policyContext(principal, schema.rolesFor(entry.partition), row, patch);
  return { op, rules, context };
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
  const resolved = resolveQuestion(schema, principal, what, row, patch, source);
  if (resolved.early !== undefined) return resolved.early.allowed;
  return evaluate(resolveAllow(resolved.rules.block, resolved.op), resolved.context);
}

/**
 * {@link can}, with its reasons: the same verdict, always, and the rung and rule that reached it.
 *
 * @example
 * const answer = why(schema, grant, "notes.update", row);
 * if (answer.rung === "policy" && !answer.allowed)
 *   console.log(answer.rule.entry, answer.because.map((step) => ruleText(step.node)));
 */
export function why(
  schema: ValidatorSchema,
  principal: Principal | undefined,
  what: `${string}.${string}`,
  row?: Row,
  patch?: Row,
  source?: PolicySource,
): PolicyWhy {
  const resolved = resolveQuestion(schema, principal, what, row, patch, source);
  if (resolved.early !== undefined) return resolved.early;
  const { rule, verdict } = explainRule(resolved.op, resolved.rules, resolved.context);
  return { allowed: verdict.allowed, rung: "policy", rule, because: verdict.because };
}

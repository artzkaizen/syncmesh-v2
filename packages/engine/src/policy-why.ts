import type {
  AllowBlock,
  Operation,
  PolicyContext,
  PolicyStep,
  PolicyVerdict,
} from "@syncmesh/policy";

import { allowEntry, explain, ruleText } from "@syncmesh/policy";

import { PolicyDenied, type PolicyRule } from "./errors.js";

/**
 * A verdict with its why (U2): which rung answered and, on the policy rung, which rule and the
 * leaves of it that decided. A reading: asking it changes nothing.
 *
 * - `table` — the manifest declares no such table; nothing may be done to it.
 * - `principal` — nothing names who this device writes as: no grant, no link.
 * - `kind` — the table has no rules, so its partition kind decides: reads always, writes on
 *   `user` and `local` tables only.
 * - `policy` — a rule decided; `rule` names it and `because` its deciding leaves.
 */
export type PolicyWhy =
  | { readonly allowed: boolean; readonly rung: "table" | "principal" | "kind" }
  | {
      readonly allowed: boolean;
      readonly rung: "policy";
      readonly rule: PolicyRule;
      readonly because: readonly PolicyStep[];
    };

/** The rule an operation was judged under, and the verdict with the leaves that reached it. */
export interface ExplainedRule {
  readonly rule: PolicyRule;
  readonly verdict: PolicyVerdict;
}

/** An allow block and where it came from, or `undefined` for a table with no rules. */
export interface SourcedRules {
  readonly block: AllowBlock;
  readonly source: PolicyRule["source"];
}

/** The block beside its source; nothing at all when there is no block to source. */
export const sourced = (
  block: AllowBlock | undefined,
  source: PolicyRule["source"],
): SourcedRules | undefined => (block === undefined ? undefined : { block, source });

/** The rule an operation is judged under, and its verdict with the leaves that reached it. */
export function explainRule(
  op: Operation,
  rules: SourcedRules,
  context: PolicyContext,
): ExplainedRule {
  const { key: entry, node } = allowEntry(rules.block, op);
  return { rule: { op, entry, source: rules.source }, verdict: explain(node, context) };
}

/**
 * A refusal with its why: on the policy rung which rule, and the leaves of it that failed; on an
 * earlier rung, which one. What the validator and a server's `actor` check both build, so the two
 * refuse in the same words.
 */
export function createPolicyDenied(
  table: string,
  key: string,
  op: Operation,
  answer: PolicyWhy,
): PolicyDenied {
  const denied = { table, key, op };
  if (answer.rung !== "policy")
    return new PolicyDenied({
      ...denied,
      message: `${op} on ${table} denied at the ${answer.rung} rung`,
    });
  const { rule, because } = answer;
  const failed = because.map((step) => ruleText(step.node)).join(", ");
  return new PolicyDenied({
    ...denied,
    rule,
    because,
    message: `${op} on ${table} denied by the ${rule.entry} rule (${rule.source}): ${failed}`,
  });
}

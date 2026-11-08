import type { CellValue } from "@syncmesh/kernel";

/** A rule as data: no closures, so every device evaluates the same one and it can sync as the `_policy` row (RFC-0008). */
export type PolicyNode =
  | { readonly kind: "allow" }
  | { readonly kind: "deny" }
  /** The grant's role is this one or more senior in the kind's ladder. */
  | { readonly kind: "role"; readonly role: string }
  /** The row's column equals the grant's account. */
  | { readonly kind: "owner"; readonly column: string }
  /** The row's column value is in the list the grant carries under `claim` (dotted path). */
  | { readonly kind: "claimHas"; readonly claim: string; readonly column: string }
  | { readonly kind: "claimEquals"; readonly claim: string; readonly column: string }
  /** A constant is in the list the grant carries under `claim` — `can(module, action)` is this. */
  | { readonly kind: "claimIncludes"; readonly claim: string; readonly value: string }
  | { readonly kind: "rowIs"; readonly where: Readonly<Record<string, CellValue>> }
  /** The row's column stands in this relation to a constant. Equality is `rowIs`; this is the rest. */
  | {
      readonly kind: "compare";
      readonly column: string;
      readonly op: CompareOp;
      readonly value: CellValue;
    }
  /** The row's column is one of these constants. */
  | { readonly kind: "isIn"; readonly column: string; readonly values: readonly CellValue[] }
  /** Every column the write touches is one of these. */
  | { readonly kind: "patchOnly"; readonly columns: readonly string[] }
  | { readonly kind: "any"; readonly of: readonly PolicyNode[] }
  | { readonly kind: "all"; readonly of: readonly PolicyNode[] }
  | { readonly kind: "not"; readonly of: PolicyNode };

/** How a column stands to a constant. Ordered comparisons hold only between two scalars of one kind. */
export type CompareOp = "ne" | "lt" | "lte" | "gt" | "gte";

export type Operation = "read" | "insert" | "update" | "delete" | "replace" | (string & {});

/** Rules per operation. `write` covers insert, update and delete; `$default` covers everything else. */
export interface AllowBlock {
  readonly $default: PolicyNode;
  readonly read?: PolicyNode;
  readonly write?: PolicyNode;
  readonly insert?: PolicyNode;
  readonly update?: PolicyNode;
  readonly delete?: PolicyNode;
  /**
   * Who may `replace()` a document column of the row — start a new lineage, the one document
   * operation that can set others' work aside (RFC-0023 §11, decided §16.2). Absent, a replace is
   * judged as the `update` it otherwise is.
   */
  readonly replace?: PolicyNode;
  readonly [custom: string]: PolicyNode | undefined;
}

const WRITES = new Set<string>(["insert", "update", "delete"]);

/**
 * `block[op] ?? block.write (for writes) ?? block.$default` — and a `replace` with no rule of its
 * own resolves exactly as `update` does.
 */
export function resolveAllow(block: AllowBlock, op: Operation): PolicyNode {
  return allowEntry(block, op).node;
}

/** Which entry of an allow block answers for an operation, and the rule it holds. */
export interface AllowEntry {
  /** The key the rule was found under: the operation's own, `write`, `update` or `$default`. */
  readonly key: string;
  readonly node: PolicyNode;
}

/** {@link resolveAllow}, naming the entry the rule came from — the "which rule" of a verdict's why. */
export function allowEntry(block: AllowBlock, op: Operation): AllowEntry {
  if (op === "replace") {
    return block.replace === undefined
      ? allowEntry(block, "update")
      : { key: "replace", node: block.replace };
  }
  const own = block[op];
  if (own !== undefined) return { key: op, node: own };
  if (WRITES.has(op) && block.write !== undefined) return { key: "write", node: block.write };
  return { key: "$default", node: block.$default };
}

export const allow: PolicyNode = { kind: "allow" };
export const deny: PolicyNode = { kind: "deny" };
export const role = (name: string): PolicyNode => ({ kind: "role", role: name });
export const owner = (column: string): PolicyNode => ({ kind: "owner", column });
export const claimHas = (claim: string, column: string): PolicyNode => ({
  kind: "claimHas",
  claim,
  column,
});
export const claimEquals = (claim: string, column: string): PolicyNode => ({
  kind: "claimEquals",
  claim,
  column,
});
export const claimIncludes = (claim: string, value: string): PolicyNode => ({
  kind: "claimIncludes",
  claim,
  value,
});
export const rowIs = (where: Readonly<Record<string, CellValue>>): PolicyNode => ({
  kind: "rowIs",
  where,
});
export const patchOnly = (columns: readonly string[]): PolicyNode => ({
  kind: "patchOnly",
  columns,
});
const compare =
  (op: CompareOp) =>
  (column: string, value: CellValue): PolicyNode => ({ kind: "compare", column, op, value });

/** Not equal — and, like every comparison here, false between values of different kinds. */
export const ne = compare("ne");
export const lt = compare("lt");
export const lte = compare("lte");
export const gt = compare("gt");
export const gte = compare("gte");
export const isIn = (column: string, values: readonly CellValue[]): PolicyNode => ({
  kind: "isIn",
  column,
  values,
});

export const any = (...of: readonly PolicyNode[]): PolicyNode => ({ kind: "any", of });
export const all = (...of: readonly PolicyNode[]): PolicyNode => ({ kind: "all", of });
export const not = (of: PolicyNode): PolicyNode => ({ kind: "not", of });

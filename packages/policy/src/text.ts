import type { CellValue } from "@syncmesh/kernel";

import type { PolicyNode } from "./ast.js";

/** A constant as the builders take it: text quoted, numbers, booleans and null bare. */
const constant = (value: CellValue): string =>
  value instanceof Uint8Array ? `<${value.byteLength} bytes>` : JSON.stringify(value);

/**
 * A rule as it would be written with this package's builders — `role("admin")`,
 * `owner("createdBy")`, `any(role("admin"), owner("createdBy"))` — for a person reading a
 * verdict's why. Total: every node has a spelling.
 *
 * @example
 * ruleText(all(role("member"), patchOnly(["title"]))); // 'all(role("member"), patchOnly(["title"]))'
 */
export function ruleText(node: PolicyNode): string {
  switch (node.kind) {
    case "allow":
    case "deny":
      return node.kind;
    case "role":
      return `role(${JSON.stringify(node.role)})`;
    case "owner":
      return `owner(${JSON.stringify(node.column)})`;
    case "claimHas":
    case "claimEquals":
      return `${node.kind}(${JSON.stringify(node.claim)}, ${JSON.stringify(node.column)})`;
    case "claimIncludes":
      return `claimIncludes(${JSON.stringify(node.claim)}, ${JSON.stringify(node.value)})`;
    case "rowIs":
      return `rowIs({ ${Object.entries(node.where)
        .map(([column, value]) => `${column}: ${constant(value)}`)
        .join(", ")} })`;
    case "compare":
      return `${node.op}(${JSON.stringify(node.column)}, ${constant(node.value)})`;
    case "isIn":
      return `isIn(${JSON.stringify(node.column)}, [${node.values.map(constant).join(", ")}])`;
    case "patchOnly":
      return `patchOnly([${node.columns.map((c) => JSON.stringify(c)).join(", ")}])`;
    case "any":
    case "all":
      return `${node.kind}(${node.of.map(ruleText).join(", ")})`;
    case "not":
      return `not(${ruleText(node.of)})`;
  }
}

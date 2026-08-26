import type { Row } from "@syncmesh/kernel";

import { evaluate, resolveAllow, type Operation } from "@syncmesh/policy";

import { policyContext, type Principal, type ValidatorSchema } from "./validate.js";

/**
 * The UI's question, answered by the same rule the receivers enforce: `"table.op"` against a row,
 * for a principal — the device's grant, or an actor a server acts as. A table with no `allow`
 * block is readable by anyone who holds it and writable only where the kind itself says so.
 */
export function can(
  schema: ValidatorSchema,
  principal: Principal | undefined,
  what: `${string}.${string}`,
  row?: Row,
  patch?: Row,
): boolean {
  const dot = what.indexOf(".");
  const table = what.slice(0, dot);
  const op: Operation = what.slice(dot + 1);
  const entry = schema.entries.find((e) => String(e.table.name) === table);
  if (entry === undefined || principal === undefined) return false;
  if (entry.allow === undefined)
    return op === "read" || entry.partition === "user" || entry.partition === "local";
  return evaluate(
    resolveAllow(entry.allow, op),
    policyContext(principal, schema.rolesFor(entry.partition), row, patch),
  );
}

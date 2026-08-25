import type { Row } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { evaluate, resolveAllow, type Operation } from "@syncmesh/policy";

import { policyContext, type ValidatorSchema } from "./validate.js";

/** The UI's question, answered by the same rule the receivers enforce: `"table.op"` against a row. */
export function can(
  schema: ValidatorSchema,
  grant: Grant | undefined,
  what: `${string}.${string}`,
  row?: Row,
  patch?: Row,
): boolean {
  const dot = what.indexOf(".");
  const table = what.slice(0, dot);
  const op: Operation = what.slice(dot + 1);
  const entry = schema.entries.find((e) => String(e.table.name) === table);
  if (entry === undefined || grant === undefined) return false;
  if (entry.allow === undefined) return entry.partition === "user" || entry.partition === "local";
  return evaluate(
    resolveAllow(entry.allow, op),
    policyContext(grant, schema.rolesFor(entry.partition), row, patch),
  );
}

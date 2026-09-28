import type { Principal } from "@syncmesh/engine";
import type { CellValue, JsonValue } from "@syncmesh/kernel";
import type { AllowBlock, PolicyNode, RoleSet, ScalarKind } from "@syncmesh/policy";
import type { ColumnKind, Table } from "@syncmesh/schema";

import { claimAt, resolveAllow, roleAtLeast, scalarKindOf } from "@syncmesh/policy";

import type { SqlDialect, SqlValue } from "./driver.js";

import { POSTGRES, SQLITE } from "./dialect.js";
import { columnsOf, quote } from "./identifiers.js";

/**
 * A `read` rule compiled to a SQL predicate over the table's own columns (D20 §2): what
 * `mesh.as(principal).db` puts under every source so a row the principal may not read is
 * absent by construction. The same verdict `evaluate()` gives for a stored row with no patch —
 * pinned by the driver suite against `can()` — for every node the rule language has.
 */
export interface Compiled {
  /** The predicate with one `?` per param, in order — a portable form any dialect's binder places. */
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

export interface CompileOptions {
  /** Whose constants and cell forms the predicate uses. Default `sqlite`. */
  readonly dialect?: SqlDialect;
}

/** The scalar kind a column's values have in a rule's eyes; a json or blob column is no identity, so nothing matches it. */
export const columnScalarKind = (kind: ColumnKind): ScalarKind | undefined => {
  switch (kind) {
    case "text":
    case "uuid":
      return "string";
    case "integer":
    case "float":
    case "timestamp":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return undefined;
  }
};

/** Whether `evaluate`'s strict `===` between the column's cell and `value` could ever hold — the same kind, or both null. */
const comparable = (kind: ColumnKind, value: JsonValue | CellValue | undefined): boolean => {
  const scalar = scalarKindOf(value);
  return scalar !== undefined && (scalar === "null" || scalar === columnScalarKind(kind));
};

/** One compiler per node, mirroring `evaluate`'s handler table, so the two cannot drift apart silently. */
type Handlers = {
  readonly [K in PolicyNode["kind"]]: (node: Extract<PolicyNode, { kind: K }>) => Compiled;
};

const join = (parts: readonly Compiled[], op: "AND" | "OR"): Compiled => ({
  sql: `(${parts.map((p) => p.sql).join(` ${op} `)})`,
  params: parts.flatMap((p) => p.params),
});

export function compileRead(
  table: Table,
  roles: RoleSet,
  allow: AllowBlock | undefined,
  principal: Principal,
  options: CompileOptions = {},
): Compiled {
  const dialect = options.dialect === "postgres" ? POSTGRES : SQLITE;
  const OPERATORS = { ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;

  const ALWAYS: Compiled = { sql: dialect.name === "postgres" ? "TRUE" : "1", params: [] };
  const NEVER: Compiled = { sql: dialect.name === "postgres" ? "FALSE" : "0", params: [] };
  // a table with no rules is readable by anyone who holds it — what can() says for "read"
  if (allow === undefined) return ALWAYS;
  const columns = new Map(columnsOf(table).map(([key, name, column]) => [key, { name, column }]));

  /** `column = value` as evaluate() would compare it, or a constant when it never could. */
  const equals = (key: string, value: JsonValue | CellValue | undefined): Compiled => {
    const found = columns.get(key);
    if (found === undefined || !comparable(found.column.def.kind, value)) return NEVER;
    if (value === null) return { sql: `${quote(found.name)} IS NULL`, params: [] };
    // SAFETY: comparable() proved value a scalar of the column's own kind, which is a CellValue
    return {
      sql: `${quote(found.name)} = ?`,
      params: [dialect.cell(found.column.def.kind, value as CellValue)],
    };
  };

  const compile = (node: PolicyNode): Compiled =>
    // SAFETY: handlers is total over PolicyNode["kind"], and each handler's node type is the member with that kind
    (handlers[node.kind] as (n: PolicyNode) => Compiled)(node);

  const handlers: Handlers = {
    allow: () => ALWAYS,
    deny: () => NEVER,
    role: (node) => (roleAtLeast(roles, principal.role, node.role) ? ALWAYS : NEVER),
    owner: (node) => equals(node.column, principal.account),
    claimHas: (node) => {
      const list = claimAt(principal.claims, node.claim);
      const found = columns.get(node.column);
      if (!Array.isArray(list) || found === undefined) return NEVER;
      const items = list.filter((item) => comparable(found.column.def.kind, item) && item !== null);
      if (items.length === 0) return NEVER;
      return {
        sql: `${quote(found.name)} IN (${items.map(() => "?").join(", ")})`,
        // SAFETY: each item passed comparable() for this column's kind, so it is a CellValue of that kind
        params: items.map((item) => dialect.cell(found.column.def.kind, item as CellValue)),
      };
    },
    claimEquals: (node) => equals(node.column, claimAt(principal.claims, node.claim)),
    claimIncludes: (node) => {
      const list = claimAt(principal.claims, node.claim);
      return Array.isArray(list) && list.some((item) => item === node.value) ? ALWAYS : NEVER;
    },
    rowIs: (node) => {
      const parts = Object.entries(node.where).map(([key, expected]) => equals(key, expected));
      return parts.length === 0 ? ALWAYS : join(parts, "AND");
    },
    compare: (node) => {
      const found = columns.get(node.column);
      if (found === undefined || !comparable(found.column.def.kind, node.value)) return NEVER;
      const kind = columnScalarKind(found.column.def.kind);
      // an ordered comparison holds between two scalars of one orderable kind, and nowhere else
      if (node.op !== "ne" && (kind === undefined || kind === "boolean")) return NEVER;
      if (node.value === null) return NEVER; // null orders against nothing, and `ne null` is `IS NOT NULL`
      const sql = `${quote(found.name)} ${OPERATORS[node.op]} ?`;
      return { sql, params: [dialect.cell(found.column.def.kind, node.value)] };
    },
    isIn: (node) => {
      const found = columns.get(node.column);
      if (found === undefined) return NEVER;
      const items = node.values.filter(
        (item) => comparable(found.column.def.kind, item) && item !== null,
      );
      if (items.length === 0) return NEVER;
      return {
        sql: `${quote(found.name)} IN (${items.map(() => "?").join(", ")})`,
        params: items.map((item) => dialect.cell(found.column.def.kind, item)),
      };
    },
    // a read carries no patch, so nothing it touches can fall outside the list
    patchOnly: () => ALWAYS,
    any: (node) => (node.of.length === 0 ? NEVER : join(node.of.map(compile), "OR")),
    all: (node) => (node.of.length === 0 ? ALWAYS : join(node.of.map(compile), "AND")),
    not: (node) => {
      const inner = compile(node.of);
      return { sql: `NOT (${inner.sql})`, params: inner.params };
    },
  };

  return compile(resolveAllow(allow, "read"));
}

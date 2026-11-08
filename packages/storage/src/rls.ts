import type { Principal, StoreFailure, ValidatorSchema } from "@syncmesh/engine";
import type { CellValue, JsonValue } from "@syncmesh/kernel";
import type { PartitionKey } from "@syncmesh/kernel";
import type { AllowBlock, PolicyNode, RoleSet, ScalarKind } from "@syncmesh/policy";
import type { Result } from "@syncmesh/result";
import type { ColumnKind, Table } from "@syncmesh/schema";

import { resolveAllow, scalarKind } from "@syncmesh/policy";

import type { SqlDriver, SqlValue } from "./driver.js";

import { tableColumns, quote } from "./identifiers.js";
import { columnScalarKind } from "./read-filter.js";
import { attempt } from "./sql.js";

/**
 * The schema's `read` rules as Postgres row-level security (D20 §2, the server half): the caller's
 * principal rides in transaction-local settings, and a policy compiled from the same AST every
 * device evaluates filters every `SELECT` — so a plain `db.select().from(jobs)` on an authority is
 * already the caller's view, with no wrapper at the call site. Writes are deliberately open at
 * this layer: capture judges them against the same rules before COMMIT.
 */

const OPERATORS = { ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;

/** A scalar as SQL text in the form its kind takes; the caller has already proved the kind. */
const sqlLiteral = (kind: ScalarKind, value: CellValue): string => {
  if (kind === "string") {
    // SAFETY: the caller matched scalarKind(value) against `kind`, so this one is a string
    return str(value as string);
  }
  if (kind === "boolean") return value === true ? "TRUE" : "FALSE";
  return String(Number(value));
};

const GUC = {
  account: "syncmesh.account",
  role: "syncmesh.role",
  claims: "syncmesh.claims",
  partition: "syncmesh.partition",
} as const;

/** A setting's value, absent-or-empty normalised to SQL NULL. */
const setting = (name: string): string => `NULLIF(current_setting('${name}', TRUE), '')`;

/**
 * Where a policy reads the principal from, as SQL: its account and role as text, its claims as
 * `jsonb`, each NULL when there is none.
 */
export interface PrincipalSource {
  readonly account: string;
  readonly role: string;
  readonly claims: string;
}

/** The principal in the transaction's `syncmesh.*` settings, as `principalSettings` sets them. */
export const SETTINGS = {
  account: setting(GUC.account),
  role: setting(GUC.role),
  claims: `${setting(GUC.claims)}::jsonb`,
} as const satisfies PrincipalSource;

export const str = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** The column as `evaluate` compares it: numbers as numbers, timestamps as their epoch milliseconds. */
const columnExpr = (kind: ColumnKind, name: string): string => {
  switch (kind) {
    case "integer":
    case "float":
      return `${name}::float8`;
    case "timestamp":
      return `(EXTRACT(EPOCH FROM ${name}) * 1000)::float8`;
    default:
      return name;
  }
};

/** The cast that takes a JSON scalar's text to the column's comparison type. */
const jsonCast = (scalar: ScalarKind): string =>
  scalar === "number" ? "::float8" : scalar === "boolean" ? "::boolean" : "";

/** `claimAt`'s dot-path walk: each step yields NULL unless the value so far is an object. */
const claimExpr = (claims: string, path: string): string => {
  let current = claims;
  for (const segment of path.split(".")) {
    current = `(CASE WHEN jsonb_typeof(${current}) = 'object' THEN (${current}) -> ${str(segment)} ELSE NULL END)`;
  }
  return current;
};

/**
 * Every comparison leaf lands in COALESCE(…, FALSE): a NULL cell must read as "rule not
 * satisfied", exactly as `evaluate` treats it — never as SQL's unknown, which a NOT would flip.
 */
const leaf = (sql: string): string => `COALESCE(${sql}, FALSE)`;

type Handlers = {
  readonly [K in PolicyNode["kind"]]: (node: Extract<PolicyNode, { kind: K }>) => string;
};

/**
 * The table's `read` rule as SQL: one compiler per node, mirroring `evaluate`'s handler table, so
 * the two cannot drift apart silently. The principal is read from `from`: the transaction's
 * settings unless told otherwise.
 */
export function policyPredicate(
  table: Table,
  roles: RoleSet,
  allow: AllowBlock,
  from: PrincipalSource = SETTINGS,
): string {
  return rulePredicate(table, roles, resolveAllow(allow, "read"), from);
}

/** One rule as SQL — a table's resolved `read` rule, or a column's field rule (E06, D40). */
export function rulePredicate(
  table: Table,
  roles: RoleSet,
  rule: PolicyNode,
  from: PrincipalSource = SETTINGS,
): string {
  const columns = new Map(
    tableColumns(table).map(([key, name, column]) => [key, { name: quote(name), column }]),
  );

  const equalsLiteral = (key: string, expected: JsonValue | CellValue | undefined): string => {
    const found = columns.get(key);
    const kind = found === undefined ? undefined : columnScalarKind(found.column.def.kind);
    const scalar = scalarKind(expected);
    if (found === undefined || scalar === undefined) return "FALSE";
    if (scalar === "null") return `(${found.name} IS NULL)`;
    if (scalar !== kind) return "FALSE";
    // SAFETY: scalarKind proved the shape — a string is quoted, a boolean its keyword, a number prints as itself
    const value =
      scalar === "string"
        ? str(expected as string)
        : scalar === "boolean"
          ? expected === true
            ? "TRUE"
            : "FALSE"
          : String(Number(expected));
    return leaf(`${columnExpr(found.column.def.kind, found.name)} = ${value}`);
  };

  const compile = (node: PolicyNode): string =>
    // SAFETY: handlers is total over PolicyNode["kind"], and each handler's node type is the member with that kind
    (handlers[node.kind] as (n: PolicyNode) => string)(node);

  const handlers: Handlers = {
    allow: () => "TRUE",
    deny: () => "FALSE",
    // `roleAtLeast` in SQL: a ladder admits the wanted rung and every one before it, a flat set
    // admits exactly the wanted name, and a role the set does not know admits nobody
    role: (node) => {
      const needed = roles.names.indexOf(node.role);
      if (needed === -1) return "FALSE";
      if (!roles.ordered) return leaf(`${from.role} = ${str(node.role)}`);
      const array = `ARRAY[${roles.names.map(str).join(", ")}]::text[]`;
      return leaf(`array_position(${array}, ${from.role}) <= ${needed + 1}`);
    },
    owner: (node) => {
      const found = columns.get(node.column);
      if (found === undefined || columnScalarKind(found.column.def.kind) !== "string")
        return "FALSE";
      return leaf(`${found.name} = ${from.account}`);
    },
    claimHas: (node) => {
      const found = columns.get(node.column);
      const kind = found === undefined ? undefined : columnScalarKind(found.column.def.kind);
      if (found === undefined || kind === undefined) return "FALSE";
      const claim = claimExpr(from.claims, node.claim);
      const items = `SELECT ((e.v) #>> '{}')${jsonCast(kind)} FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${claim}) = 'array' THEN ${claim} ELSE '[]'::jsonb END) AS e(v) WHERE jsonb_typeof(e.v) = ${str(kind)}`;
      return leaf(`${columnExpr(found.column.def.kind, found.name)} IN (${items})`);
    },
    claimEquals: (node) => {
      const found = columns.get(node.column);
      const kind = found === undefined ? undefined : columnScalarKind(found.column.def.kind);
      if (found === undefined || kind === undefined) return "FALSE";
      const claim = claimExpr(from.claims, node.claim);
      return leaf(
        `CASE WHEN jsonb_typeof(${claim}) = 'null' THEN ${found.name} IS NULL WHEN jsonb_typeof(${claim}) = ${str(kind)} THEN ${columnExpr(found.column.def.kind, found.name)} = ((${claim}) #>> '{}')${jsonCast(kind)} ELSE FALSE END`,
      );
    },
    claimIncludes: (node) => {
      const claim = claimExpr(from.claims, node.claim);
      return leaf(
        `CASE WHEN jsonb_typeof(${claim}) = 'array' THEN (${claim}) @> ${str(JSON.stringify(node.value))}::jsonb ELSE FALSE END`,
      );
    },
    rowIs: (node) => {
      const parts = Object.entries(node.where).map(([key, expected]) =>
        equalsLiteral(key, expected),
      );
      return parts.length === 0 ? "TRUE" : `(${parts.join(" AND ")})`;
    },
    compare: (node) => {
      const found = columns.get(node.column);
      const kind = found === undefined ? undefined : columnScalarKind(found.column.def.kind);
      if (found === undefined || kind === undefined) return "FALSE";
      if (node.value === null || scalarKind(node.value) !== kind) return "FALSE";
      if (node.op !== "ne" && kind === "boolean") return "FALSE"; // a boolean has no order
      const value = sqlLiteral(kind, node.value);
      return leaf(
        `${columnExpr(found.column.def.kind, found.name)} ${OPERATORS[node.op]} ${value}`,
      );
    },
    isIn: (node) => {
      const found = columns.get(node.column);
      const kind = found === undefined ? undefined : columnScalarKind(found.column.def.kind);
      if (found === undefined || kind === undefined) return "FALSE";
      const items = node.values.filter((item) => scalarKind(item) === kind);
      if (items.length === 0) return "FALSE";
      const list = items.map((item) => sqlLiteral(kind, item)).join(", ");
      return leaf(`${columnExpr(found.column.def.kind, found.name)} IN (${list})`);
    },
    // a read carries no patch, so nothing it touches can fall outside the list
    patchOnly: () => "TRUE",
    any: (node) => (node.of.length === 0 ? "FALSE" : `(${node.of.map(compile).join(" OR ")})`),
    all: (node) => (node.of.length === 0 ? "TRUE" : `(${node.of.map(compile).join(" AND ")})`),
    not: (node) => `(NOT ${compile(node.of)})`,
  };

  return compile(rule);
}

/**
 * The open policy `servedReadDdl` gives a table that had no row-level security, so serving it
 * changes nothing for other roles. {@link rlsDdl} drops it: its own policies are the table's.
 */
export const SERVED_OPEN_POLICY = "syncmesh_served_others";

export interface RlsOptions {
  /** The column holding the partition key, pinned when the `partition` setting is set. Default `_partition`; `false` when the table has no such column. */
  readonly partitionColumn?: string | false;
}

/**
 * The DDL that puts a table's `read` rule into the database itself: RLS enabled and forced (so
 * the table's owner is filtered too), one SELECT policy from the rule, and open write policies —
 * writes are capture's to judge. The open policy a served table was given before ({@link
 * SERVED_OPEN_POLICY}) is dropped, as it would OR every row back in. Idempotent; superusers and BYPASSRLS roles are outside RLS by
 * Postgres's own rules, so serve the app through a plain role.
 */
export function rlsDdl(
  table: Table,
  roles: RoleSet,
  allow: AllowBlock | undefined,
  options: RlsOptions = {},
): readonly string[] {
  const name = quote(table.name);
  const partitionColumn = options.partitionColumn ?? "_partition";
  const filters: string[] = [];
  // a table with no rules is readable by anyone who holds it — what can() says for "read"
  if (allow !== undefined) filters.push(policyPredicate(table, roles, allow));
  if (partitionColumn !== false) {
    const column = `"${partitionColumn.replaceAll('"', '""')}"`;
    filters.push(`(${setting(GUC.partition)} IS NULL OR ${column} = ${setting(GUC.partition)})`);
  }
  const predicate = filters.length === 0 ? "TRUE" : filters.map((f) => `(${f})`).join(" AND ");
  return [
    `ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`,
    // permissive policies OR together: an open one beside the rule would read every row
    `DROP POLICY IF EXISTS "${SERVED_OPEN_POLICY}" ON ${name}`,
    `DROP POLICY IF EXISTS "syncmesh_read" ON ${name}`,
    `CREATE POLICY "syncmesh_read" ON ${name} FOR SELECT USING (${predicate})`,
    `DROP POLICY IF EXISTS "syncmesh_insert" ON ${name}`,
    `CREATE POLICY "syncmesh_insert" ON ${name} FOR INSERT WITH CHECK (TRUE)`,
    `DROP POLICY IF EXISTS "syncmesh_update" ON ${name}`,
    `CREATE POLICY "syncmesh_update" ON ${name} FOR UPDATE USING (TRUE) WITH CHECK (TRUE)`,
    `DROP POLICY IF EXISTS "syncmesh_delete" ON ${name}`,
    `CREATE POLICY "syncmesh_delete" ON ${name} FOR DELETE USING (TRUE)`,
  ];
}

/** Installs the read policies for every table the manifest syncs; idempotent. */
export function installRls(
  driver: SqlDriver,
  schema: ValidatorSchema,
  options: RlsOptions = {},
): Promise<Result<void, StoreFailure>> {
  return attempt("could not install row-level security", async () => {
    for (const entry of schema.entries) {
      const roles = schema.rolesFor(entry.partition);
      for (const sql of rlsDdl(entry.table, roles, entry.allow, options)) await driver.run(sql);
    }
  });
}

export interface PrincipalStatement {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

/** The settings that make a transaction the principal's, as `[setting, value]`. */
export const principalValues = (
  principal: Principal | undefined,
  partition: PartitionKey | undefined,
): readonly (readonly [string, string])[] => [
  // an empty value reads back as NULL through the policies' NULLIF: no principal is nobody, not somebody blank
  [GUC.account, principal?.account ?? ""],
  [GUC.role, principal?.role ?? ""],
  [GUC.claims, principal === undefined ? "" : JSON.stringify(principal.claims)],
  [GUC.partition, partition === undefined ? "" : String(partition)],
];

/**
 * The statements that make a transaction the principal's: `set_config(…, true)` is transaction-
 * local, so the settings die with COMMIT or ROLLBACK and the pooled connection carries nothing
 * over. Run them first, inside the transaction the reads will use.
 */
export function principalSettings(
  principal: Principal | undefined,
  options: { readonly partition?: PartitionKey } = {},
): readonly PrincipalStatement[] {
  return principalValues(principal, options.partition).map(([name, value]) => ({
    sql: `SELECT set_config('${name}', $1, TRUE)`,
    params: [value],
  }));
}

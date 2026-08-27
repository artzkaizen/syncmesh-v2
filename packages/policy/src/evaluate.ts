import type { CellValue, JsonValue, Row } from "@syncmesh/kernel";

import type { CompareOp, PolicyNode } from "./ast.js";

/** What a rule may read about the caller: the signed grant's account, role and claims. Nothing else. */
export interface PolicyGrant {
  readonly account: string;
  readonly role?: string;
  readonly claims: Readonly<Record<string, JsonValue>>;
}

export interface PolicyContext {
  readonly grant: PolicyGrant;
  /** The kind's role ladder, senior first. */
  readonly roles: readonly string[];
  /** The row as it is before the write; absent for an insert or a row the device does not hold. */
  readonly row?: Row;
  /** The columns the write sets; absent for a read or a delete. */
  readonly patch?: Row;
}

type Handlers = {
  readonly [K in PolicyNode["kind"]]: (
    node: Extract<PolicyNode, { kind: K }>,
    ctx: PolicyContext,
  ) => boolean;
};

const handlers: Handlers = {
  allow: () => true,
  deny: () => false,
  role: (node, ctx) => roleAtLeast(ctx.roles, ctx.grant.role, node.role),
  owner: (node, ctx) => cell(ctx, node.column) === ctx.grant.account,
  claimHas: (node, ctx) => {
    const list = claimAt(ctx.grant.claims, node.claim);
    const value = cell(ctx, node.column);
    return (
      Array.isArray(list) && value !== undefined && list.some((item) => sameScalar(item, value))
    );
  },
  claimIncludes: (node, ctx) => {
    const list = claimAt(ctx.grant.claims, node.claim);
    return Array.isArray(list) && list.some((item) => sameScalar(item, node.value));
  },
  claimEquals: (node, ctx) => {
    const value = cell(ctx, node.column);
    return value !== undefined && sameScalar(claimAt(ctx.grant.claims, node.claim), value);
  },
  rowIs: (node, ctx) =>
    Object.entries(node.where).every(([column, expected]) =>
      sameScalar(cell(ctx, column), expected),
    ),
  compare: (node, ctx) => compareCells(cell(ctx, node.column), node.op, node.value),
  isIn: (node, ctx) => {
    const value = cell(ctx, node.column);
    return value !== undefined && node.values.some((item) => sameScalar(item, value));
  },
  patchOnly: (node, ctx) => {
    const allowed = new Set<string>(node.columns);
    for (const column of (ctx.patch ?? new Map()).keys()) if (!allowed.has(column)) return false;
    return true;
  },
  any: (node, ctx) => node.of.some((n) => evaluate(n, ctx)),
  all: (node, ctx) => node.of.every((n) => evaluate(n, ctx)),
  not: (node, ctx) => !evaluate(node.of, ctx),
};

/** Pure: two devices with the same node and context get the same verdict. No clock, no lookups. */
export function evaluate(node: PolicyNode, ctx: PolicyContext): boolean {
  // SAFETY: handlers is total over PolicyNode["kind"], and each handler's node type is the member with that kind
  return (handlers[node.kind] as (n: PolicyNode, c: PolicyContext) => boolean)(node, ctx);
}

/** The value a rule sees for a column: the incoming write first, then the stored row. */
function cell(ctx: PolicyContext, column: string): CellValue | undefined {
  for (const source of [ctx.patch, ctx.row]) {
    for (const [name, value] of source ?? []) if (name === column) return value;
  }
  return undefined;
}

/**
 * `have` is `wanted` or more senior on the ladder (senior first); an unknown role on either side is
 * never enough. What `role("admin")` means in a rule — and what a server check must mean too.
 */
export function roleAtLeast(
  ladder: readonly string[],
  have: string | undefined,
  wanted: string,
): boolean {
  if (have === undefined) return false;
  const mine = ladder.indexOf(have);
  const needed = ladder.indexOf(wanted);
  return mine !== -1 && needed !== -1 && mine <= needed;
}

/** The value under a dotted path in a grant's claims; `undefined` when the path leaves the object. */
export function claimAt(
  claims: Readonly<Record<string, JsonValue>>,
  path: string,
): JsonValue | undefined {
  let current: JsonValue | undefined = claims;
  for (const key of path.split(".")) {
    if (current === null || current === undefined || Array.isArray(current) || !isObject(current))
      return undefined;
    current = current[key];
  }
  return current;
}

/* oxlint-disable anti-slop/no-runtime-typeof -- a JSON value's runtime type is the fact being checked */
const isObject = (v: JsonValue): v is { readonly [key: string]: JsonValue } =>
  typeof v === "object" && v !== null;

export type ScalarKind = "string" | "number" | "boolean" | "null";

/** The kind of a scalar a rule can compare, or `undefined` for bytes, arrays and objects — never identities. */
export const scalarKindOf = (v: JsonValue | CellValue | undefined): ScalarKind | undefined => {
  if (v === null) return "null";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return undefined;
};

/**
 * An ordered comparison, and the same strictness equality has: two scalars of one kind, or false.
 * A null orders against nothing, and a boolean has no order — both read as "the rule is not
 * satisfied", never as an accidental true.
 */
const compareCells = (
  value: CellValue | undefined,
  op: CompareOp,
  expected: CellValue,
): boolean => {
  if (op === "ne") return value !== undefined && !sameScalar(expected, value);
  const kind = scalarKindOf(value);
  if (kind === undefined || kind === "null" || kind === "boolean") return false;
  if (scalarKindOf(expected) !== kind) return false;
  // SAFETY: both sides just proved the same orderable kind — two strings, or two numbers
  const [a, b] = [value, expected] as [string, string] | [number, number];
  if (op === "lt") return a < b;
  if (op === "lte") return a <= b;
  if (op === "gt") return a > b;
  return a >= b;
};

/** Scalars compare by value; bytes, arrays and objects never match a rule (they are not identities). */
const sameScalar = (a: JsonValue | CellValue | undefined, b: CellValue): boolean =>
  scalarKindOf(a) !== undefined && a === b;
/* oxlint-enable anti-slop/no-runtime-typeof */

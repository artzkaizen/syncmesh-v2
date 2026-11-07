import type { JsonValue } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import type { AllowBlock, CompareOp, PolicyNode } from "./ast.js";

/** One partition instance's rules: table name → its allow block. This is what the `_policy` row carries. */
export type PolicyDoc = Readonly<Record<string, AllowBlock>>;

export class MalformedPolicy extends TaggedError("MalformedPolicy")<{
  path: string;
  message: string;
}> {}

const COMPARE_OPS = new Set<string>(["ne", "lt", "lte", "gt", "gte"]);

const malformed = (path: string, message: string) =>
  Result.err(new MalformedPolicy({ path, message }));

/** Parses a synced policy row. A rule that does not parse is a value; nothing partial is ever applied. */
export function parsePolicyDoc(json: JsonValue): Result<PolicyDoc, MalformedPolicy> {
  if (!isRecord(json)) return malformed("", "expected an object of tables");
  const doc: Record<string, AllowBlock> = {};
  for (const [table, block] of Object.entries(json)) {
    const parsed = parseBlock(block, table);
    if (parsed.isErr()) return parsed;
    doc[table] = parsed.value;
  }
  return Result.ok(doc);
}

function parseBlock(json: JsonValue, path: string): Result<AllowBlock, MalformedPolicy> {
  if (!isRecord(json) || json.$default === undefined)
    return malformed(path, "an allow block needs $default");
  const rules: Record<string, PolicyNode> = {};
  for (const [op, node] of Object.entries(json)) {
    const parsed = parseNode(node, `${path}.${op}`);
    if (parsed.isErr()) return parsed;
    rules[op] = parsed.value;
  }
  // SAFETY: $default was checked present above and every value parsed as a PolicyNode
  return Result.ok(rules as Record<string, PolicyNode> & { $default: PolicyNode });
}

interface Json {
  readonly [key: string]: JsonValue;
}
type Parser = (json: Json, path: string) => Result<PolicyNode, MalformedPolicy>;

const parsers = {
  allow: () => Result.ok({ kind: "allow" }),
  deny: () => Result.ok({ kind: "deny" }),
  role: (j: Json, p: string) =>
    isString(j.role)
      ? Result.ok({ kind: "role", role: j.role })
      : malformed(p, "role needs a name"),
  owner: (j: Json, p: string) =>
    isString(j.column)
      ? Result.ok({ kind: "owner", column: j.column })
      : malformed(p, "owner needs a column"),
  compare: (j: Json, p: string) =>
    isString(j.column) && isString(j.op) && COMPARE_OPS.has(j.op) && isCellValue(j.value)
      ? // SAFETY: COMPARE_OPS holds exactly the CompareOp members, and the guard just matched one
        Result.ok({ kind: "compare", column: j.column, op: j.op as CompareOp, value: j.value })
      : malformed(p, "compare needs a column, one of ne/lt/lte/gt/gte, and a scalar"),
  isIn: (j: Json, p: string) =>
    isString(j.column) && Array.isArray(j.values) && j.values.every(isCellValue)
      ? Result.ok({ kind: "isIn", column: j.column, values: j.values })
      : malformed(p, "isIn needs a column and a list of scalars"),
  claimHas: (j: Json, p: string) =>
    isString(j.claim) && isString(j.column)
      ? Result.ok({ kind: "claimHas", claim: j.claim, column: j.column })
      : malformed(p, "claimHas needs a claim and a column"),
  claimEquals: (j: Json, p: string) =>
    isString(j.claim) && isString(j.column)
      ? Result.ok({ kind: "claimEquals", claim: j.claim, column: j.column })
      : malformed(p, "claimEquals needs a claim and a column"),
  claimIncludes: (j: Json, p: string) =>
    isString(j.claim) && isString(j.value)
      ? Result.ok({ kind: "claimIncludes", claim: j.claim, value: j.value })
      : malformed(p, "claimIncludes needs a claim and a value"),
  rowIs: (j: Json, p: string) =>
    isRecord(j.where) && Object.values(j.where).every(isScalar)
      ? Result.ok({ kind: "rowIs", where: j.where })
      : malformed(p, "rowIs needs scalar values"),
  patchOnly: (j: Json, p: string) =>
    Array.isArray(j.columns) && j.columns.every(isString)
      ? Result.ok({ kind: "patchOnly", columns: j.columns })
      : malformed(p, "patchOnly needs column names"),
  any: (j: Json, p: string) => parseList(j.of, p).map((of) => ({ kind: "any", of })),
  all: (j: Json, p: string) => parseList(j.of, p).map((of) => ({ kind: "all", of })),
  not: (j: Json, p: string) =>
    parseNode(j.of ?? null, `${p}.of`).map((of) => ({ kind: "not", of })),
} satisfies Readonly<Record<PolicyNode["kind"], Parser>>;

function parseNode(json: JsonValue, path: string): Result<PolicyNode, MalformedPolicy> {
  if (!isRecord(json) || !isString(json.kind)) return malformed(path, "a rule needs a kind");
  // SAFETY: hasOwn just established json.kind is one of the parser keys
  const parser: Parser | undefined = Object.hasOwn(parsers, json.kind)
    ? parsers[json.kind as PolicyNode["kind"]]
    : undefined;
  return parser === undefined
    ? malformed(path, `unknown rule kind "${json.kind}"`)
    : parser(json, path);
}

function parseList(
  json: JsonValue | undefined,
  path: string,
): Result<readonly PolicyNode[], MalformedPolicy> {
  if (!Array.isArray(json)) return malformed(path, "expected a list of rules");
  const out: PolicyNode[] = [];
  for (const [i, item] of json.entries()) {
    const parsed = parseNode(item, `${path}.of[${i}]`);
    if (parsed.isErr()) return parsed;
    out.push(parsed.value);
  }
  return Result.ok(out);
}

/* oxlint-disable anti-slop/no-runtime-typeof -- parsing a synced JSON row is the I/O boundary */
const isRecord = (v: JsonValue | undefined): v is { readonly [key: string]: JsonValue } =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: JsonValue | undefined): v is string => typeof v === "string";
const isScalar = (v: JsonValue): v is string | number | boolean | null =>
  v === null || typeof v !== "object";
/** The same, for a position a malformed doc may simply have left out. */
const isCellValue = (v: JsonValue | undefined): v is string | number | boolean | null =>
  v !== undefined && isScalar(v);
/* oxlint-enable anti-slop/no-runtime-typeof */

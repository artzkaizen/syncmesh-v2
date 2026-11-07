import type { AnyMetaPlugin, AnyProcedureContract, ErrorMap, RouterContract } from "@orpc/contract";
import type { JsonValue } from "@syncmesh/kernel";
import type { StandardSchemaV1 } from "@syncmesh/schema";

import { defineMeta, oc } from "@orpc/contract";
import { omitUndefined } from "@syncmesh/result";

import type { DeclaredErrors, ProcedureDef, RouteMeta, Router } from "./procedures.js";

import { isDef } from "./procedures.js";

/**
 * The router as an oRPC contract (D10: procedures are oRPC), for everything downstream of a
 * contract: a client built from it alone, a `contract.json` a build ships, OpenAPI. The defs
 * stay the source of truth — this is a projection of them, leaf for leaf, and never edited.
 */

/** `.route()` metadata under the name OpenAPI readers look for it: method, path, tags. */
export const [routeMeta, readRoute] = defineMeta<"route", RouteMeta>(
  "route",
  (incoming, current) => ({
    ...current,
    ...incoming,
  }),
);

/** Which kind of leaf declared the contract, and — for a gate — which grammar it took. */
export interface LeafKind {
  readonly kind: ProcedureDef["kind"];
  readonly via: "query" | "mutation";
}

/** Where a leaf runs — on the device, or on the authority — which the contract alone cannot say. */
export const [kindMeta, readLeafKind] = defineMeta<"syncmesh", LeafKind>(
  "syncmesh",
  (incoming) => incoming,
);

/** A gate's declared errors as oRPC's error map: one code per tag, with its default message. */
export const errorMap = (declared: DeclaredErrors): ErrorMap =>
  Object.fromEntries(
    Object.entries(declared).map(([tag, spec]) => [
      tag,
      spec.message === undefined ? {} : { message: spec.message },
    ]),
  );

/** Every `(path, def)` leaf of the router, walked once. */
export const leaves = (node: Router, prefix = ""): readonly (readonly [string, ProcedureDef])[] =>
  Object.entries(node).flatMap(([name, child]) => {
    const path = prefix === "" ? name : `${prefix}.${name}`;
    return isDef(child) ? [[path, child] as const] : leaves(child, path);
  });

const leafVia = (def: ProcedureDef): LeafKind["via"] =>
  def.kind === "authority" ? def.via : def.kind;

const leafContract = (def: ProcedureDef): AnyProcedureContract => {
  const plugins: AnyMetaPlugin[] = [kindMeta({ kind: def.kind, via: leafVia(def) })];
  if (def.route !== undefined) plugins.push(routeMeta(def.route));
  const headed = oc.meta(...plugins);
  const withErrors =
    def.kind === "authority" && def.errors !== undefined
      ? headed.errors(errorMap(def.errors))
      : headed;
  const withInput = def.schema === undefined ? withErrors : withErrors.input(def.schema);
  return def.kind === "authority" && def.output !== undefined
    ? withInput.output(def.output)
    : withInput;
};

/** The router as an oRPC contract router, group for group and leaf for leaf. */
export function toContract(router: Router): RouterContract {
  const out: Record<string, RouterContract> = {};
  for (const [name, child] of Object.entries(router))
    out[name] = isDef(child) ? leafContract(child) : toContract(child);
  return out;
}

/** One leaf of {@link contractJson}: everything about it a build can write down without its schemas. */
export interface ContractLeaf {
  readonly path: string;
  readonly kind: ProcedureDef["kind"];
  readonly via: LeafKind["via"];
  readonly route?: RouteMeta;
  readonly errors?: Readonly<Record<string, { readonly message?: string }>>;
  /** The input's JSON Schema where {@link ContractJsonOptions.jsonSchema} could produce one; `true` where there is a schema it could not. */
  readonly input?: JsonValue | true;
  readonly output?: JsonValue | true;
}

export interface ContractJsonOptions {
  /**
   * How a Standard Schema becomes JSON Schema — `z.toJSONSchema` for zod 4. Absent, a leaf's
   * schemas are noted as present and not described, because a Standard Schema has no JSON
   * Schema of its own to give.
   */
  readonly jsonSchema?: (schema: StandardSchemaV1) => JsonValue | undefined;
}

/** What a build writes to `contract.json`: the router's leaves, their routes, errors and schemas. */
export interface ContractJson {
  readonly version: 1;
  readonly procedures: readonly ContractLeaf[];
}

const described = (
  schema: StandardSchemaV1 | undefined,
  options: ContractJsonOptions,
): JsonValue | true | undefined =>
  schema === undefined ? undefined : (options.jsonSchema?.(schema) ?? true);

/** The contract as plain JSON, for a build to write beside the bundle and a tool to read back. */
export function contractJson(router: Router, options: ContractJsonOptions = {}): ContractJson {
  return {
    version: 1,
    procedures: leaves(router).map(([path, def]): ContractLeaf =>
      omitUndefined({
        path,
        kind: def.kind,
        via: leafVia(def),
        route: def.route,
        errors: def.kind === "authority" ? def.errors : undefined,
        input: described(def.schema, options),
        output: def.kind === "authority" ? described(def.output, options) : undefined,
      }),
    ),
  };
}

/** The slice of an OpenAPI operation `.route()` metadata can honestly fill. */
export interface OpenApiOperation {
  readonly operationId: string;
  tags?: readonly string[];
  parameters?: readonly {
    readonly name: string;
    readonly in: "query";
    readonly schema: JsonValue;
  }[];
  requestBody?: {
    readonly content: { readonly "application/json": { readonly schema: JsonValue } };
  };
  responses: Record<
    string,
    {
      readonly description: string;
      readonly content?: Record<string, { readonly schema: JsonValue }>;
    }
  >;
}

/** Plain-JSON schema for a leaf, or nothing where the build could not describe one. */
const leafSchema = (leaf: ContractLeaf, side: "input" | "output"): JsonValue | undefined => {
  const held = leaf[side];
  return held === true || held === undefined ? undefined : held;
};

/**
 * OpenAPI 3.1 from the contract: every leaf with a `.route()` path, under the method it named,
 * its declared errors as 422s, and its schemas wherever the build could describe them. Authority
 * calls are plain request/response, so the spec is too; a query or a mutation with a route
 * appears the same way, because the same fetch handler serves it.
 */
export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
}

/** An OpenAPI 3.1 document: the routed leaves, by path and then by method. */
export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: OpenApiInfo;
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
}

export function openApi(contract: ContractJson, info: OpenApiInfo): OpenApiDocument {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  for (const leaf of contract.procedures) {
    if (leaf.route?.path === undefined) continue;
    const method = (leaf.route.method ?? "POST").toLowerCase();
    const operation: OpenApiOperation = { operationId: leaf.path, responses: {} };
    if (leaf.route.tags !== undefined) operation.tags = leaf.route.tags;
    const input = leafSchema(leaf, "input");
    if (input !== undefined) {
      if (method === "get") operation.parameters = [{ name: "input", in: "query", schema: input }];
      else operation.requestBody = { content: { "application/json": { schema: input } } };
    }
    const output = leafSchema(leaf, "output");
    operation.responses["200"] =
      output === undefined
        ? { description: "the answer" }
        : { description: "the answer", content: { "application/json": { schema: output } } };
    for (const [tag, spec] of Object.entries(leaf.errors ?? {}))
      operation.responses["422"] = { description: spec.message ?? tag };
    paths[leaf.route.path] = { ...paths[leaf.route.path], [method]: operation };
  }
  return { openapi: "3.1.0", info, paths };
}

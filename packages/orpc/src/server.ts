import type { ColumnsMap, PartitionTree, PresenceMap, Roles } from "@syncmesh/schema";

import type { Api, AuthorityHandlers, ProcedureDef, Router } from "./api.js";
import type { App } from "./app.js";
import type { ClientOptions } from "./options.js";

import { isDef } from "./api.js";
import { createApp } from "./app.js";
import { createHandler } from "./http.js";
import { flatten, named } from "./options.js";
import { replicaFor } from "./scope.js";

/**
 * A server is a node with extra duties, not a different world (book ch. 19): it folds events and
 * holds partitions like any device, and on top of that it runs the router's `.authority()`
 * bodies, answers thin HTTP clients, and hosts the watchdogs whose reactions are corrections.
 */
export interface ServerOptions<
  R extends Router,
  P extends PartitionTree,
  RS extends Roles<P>,
  C extends ColumnsMap,
  PC extends PresenceMap,
> extends Omit<ClientOptions<R, P, RS, C, PC>, "link"> {
  /** The router's `.authority()` leaves, mirrored — completeness checked by the type. */
  readonly handlers?: AuthorityHandlers<R>;
  /** Started with the server, stopped with it; each takes the api and returns its teardown. */
  readonly watchdogs?: readonly ((api: Api<R>) => () => void)[];
}

export interface Server<
  R extends Router,
  PC extends PresenceMap = Record<string, never>,
> extends App<R, PC> {
  /** A standard fetch handler — mount it anywhere. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** From `.route()` metadata: authority calls are plain request/response, so the spec is too. */
  readonly openapi: (info: { readonly title: string; readonly version: string }) => object;
  /** Stops the watchdogs, then the mesh. */
  readonly stop: () => Promise<void>;
}

/** Every `(path, def)` leaf of the router, walked once. */
const leaves = (node: Router, prefix = ""): readonly (readonly [string, ProcedureDef])[] =>
  Object.entries(node).flatMap(([name, child]) => {
    const path = prefix === "" ? name : `${prefix}.${name}`;
    return isDef(child) ? [[path, child] as const] : leaves(child, path);
  });

/** The slice of an OpenAPI operation `.route()` metadata can honestly fill. */
interface OpenApiOperation {
  readonly operationId: string;
  tags?: readonly string[];
  responses?: Readonly<Record<string, { readonly description: string }>>;
}

export async function createServer<
  R extends Router,
  P extends PartitionTree,
  const RS extends Roles<P>,
  C extends ColumnsMap,
  PC extends PresenceMap = Record<string, never>,
>(options: ServerOptions<R, P, RS, C, PC>): Promise<Server<R, PC>> {
  const { handlers, watchdogs, ...clientOptions } = options;
  // the same construction a device makes: a server is a node with extra duties (ch. 19)
  const app = await createApp(flatten(await named(clientOptions)));

  const handlerOptions = { procedures: options.procedures, api: app.api };
  if (handlers !== undefined)
    Object.assign(handlerOptions, {
      // the replica comes from the call's own input, because scope is input (ch. 3) — a server
      // is a node with extra duties, not one that gets to be bound to a tenant
      gate: {
        handlers,
        handle: replicaFor(app.mesh.schema, (scope) => app.mesh.on(scope).unwrap()),
      },
    });
  const fetch = createHandler(handlerOptions);

  const stops = (watchdogs ?? []).map((start) => start(app.api));

  const openapi: Server<R, PC>["openapi"] = (info) => {
    const paths: Record<string, Record<string, OpenApiOperation>> = {};
    for (const [name, def] of leaves(options.procedures)) {
      if (def.route?.path === undefined) continue;
      const method = (def.route.method ?? "POST").toLowerCase();
      const operation: OpenApiOperation = { operationId: name };
      if (def.route.tags !== undefined) operation.tags = def.route.tags;
      if (def.kind === "authority" && def.errors !== undefined)
        operation.responses = Object.fromEntries(
          Object.entries(def.errors).map(([tag, spec]) => [
            "422",
            { description: spec.message ?? tag },
          ]),
        );
      paths[def.route.path] = { ...paths[def.route.path], [method]: operation };
    }
    return { openapi: "3.1.0", info, paths };
  };

  return {
    ...app,
    fetch,
    openapi,
    stop: async () => {
      for (const stop of stops) stop();
      await app.mesh.stop();
    },
  };
}

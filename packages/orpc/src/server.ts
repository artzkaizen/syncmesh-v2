import type { ColumnsMap, PresenceMap } from "@syncmesh/schema";

import type { Api, AuthorityHandlers, ProcedureDef, Router } from "./api.js";
import type { Client } from "./client.js";
import type { Custody, Serving } from "./custody.js";
import type { ClientOptions } from "./options.js";

import { isDef } from "./api.js";
import { createClient } from "./client.js";
import { serveCustody } from "./custody.js";
import { createHandler } from "./http.js";
import { replicaFor } from "./scope.js";

/**
 * A server is a node with extra duties, not a different world (book ch. 19): it folds events and
 * holds partitions like any device, and on top of that it runs the router's `.authority()`
 * bodies, answers thin HTTP clients, and hosts the watchdogs whose reactions are corrections.
 */
export interface ServerOptions<
  R extends Router,
  C extends ColumnsMap,
  PC extends PresenceMap,
> extends Omit<ClientOptions<R, C, PC>, "link"> {
  /** The router's `.authority()` leaves, mirrored — completeness checked by the type. */
  readonly handlers?: AuthorityHandlers<R>;
  /**
   * Serve custody: accept peers over WebSocket and keep what they send ({@link Custody}).
   *
   * With no `handlers` beside it this **is** the relay — the pure-custody configuration, and the
   * reason `startRelay` is no longer an entry of its own. With handlers it is an authority that
   * also happens to be reachable by radio, which is a deployment choice and not a second kind of
   * node.
   */
  readonly custody?: Custody;
  /** Started with the server, stopped with it; each takes the api and returns its teardown. */
  readonly watchdogs?: readonly ((api: Api<R>) => () => void)[];
}

export type Server<R extends Router, PC extends PresenceMap = Record<string, never>> = Client<
  R,
  PC
> & {
  /** The same surface as a callable: what a handler mounts and a watchdog is handed. */
  readonly api: Client<R, PC>;
  /** The mesh underneath, for the few facts that are neither a procedure nor `$`-surface. */
  readonly mesh: Client<R, PC>["$mesh"];
  /** A standard fetch handler — mount it anywhere. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** From `.route()` metadata: authority calls are plain request/response, so the spec is too. */
  readonly openapi: (info: { readonly title: string; readonly version: string }) => object;
  /** Where peers dial this node, when it serves custody; absent when it only answers HTTP. */
  readonly serving?: Serving;
  /** Stops the watchdogs, the rooms it serves, then the mesh. */
  readonly stop: () => Promise<void>;
};

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
  C extends ColumnsMap,
  PC extends PresenceMap = Record<string, never>,
>(options: ServerOptions<R, C, PC>): Promise<Server<R, PC>> {
  const { handlers, watchdogs, custody, ...clientOptions } = options;
  // the same construction a device makes: a server is a node with extra duties (ch. 19)
  const client = createClient(clientOptions);
  await client.$ready;

  const handlerOptions = { procedures: options.procedures, api: client };
  if (handlers !== undefined)
    Object.assign(handlerOptions, {
      // the replica comes from the call's own input, because scope is input (ch. 3) — a server
      // is a node with extra duties, not one that gets to be bound to a tenant
      gate: {
        handlers,
        handle: replicaFor(client.$schema, (scope) => client.$mesh.on(scope).unwrap()),
      },
    });
  const fetch = createHandler(handlerOptions);

  const stops = (watchdogs ?? []).map((start) => start(client));
  const serving = custody === undefined ? undefined : await serveCustody(custody);

  const openapi = (info: { readonly title: string; readonly version: string }) => {
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

  // assigned onto the client rather than spread: the client is a walked tree of callables, and
  // spreading one would copy the leaves off their own group objects
  const served = Object.assign(client, {
    api: client,
    mesh: client.$mesh,
    fetch,
    openapi,
    stop: async () => {
      for (const stop of stops) stop();
      await serving?.stop();
      await client.$close();
    },
  });
  if (serving !== undefined) Object.assign(served, { serving });
  // SAFETY: every member `Server` names beyond `Client` is assigned right here
  return served as Server<R, PC>;
}

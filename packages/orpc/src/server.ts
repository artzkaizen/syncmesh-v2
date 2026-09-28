import type { BunWebSocketHandlers, RelayHost } from "@syncmesh/relay";
import type { ColumnsMap, PresenceMap } from "@syncmesh/schema";

import type { Api, AuthorityHandlers, Router } from "./api.js";
import type { Client } from "./client.js";
import type { Custody, InlineCustody, Serving, Upgrading } from "./custody.js";
import type { ClientOptions } from "./options.js";

import { createClient } from "./client.js";
import { contractJson, openApi } from "./contract.js";
import { inlineCustody, serveCustody } from "./custody.js";
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

/**
 * The server's fetch, in its two shapes.
 *
 * With one argument it is a standard handler: procedures, and a room described on a plain `GET`
 * when custody is inline. With Bun's server as the second, it is the single-port recipe — an
 * upgrade is taken and `undefined` comes back, which is what Bun expects once a socket is its.
 *
 * @example
 * Bun.serve({ port, fetch: (request, bun) => server.fetch(request, bun), websocket: server.websocket });
 */
export interface ServerFetch {
  (request: Request): Promise<Response>;
  (request: Request, upgrading: Upgrading): Promise<Response | undefined>;
}

export type Server<R extends Router, PC extends PresenceMap = Record<string, never>> = Client<
  R,
  PC
> & {
  /** The same surface as a callable: what a handler mounts and a watchdog is handed. */
  readonly api: Client<R, PC>;
  /** The mesh underneath, for the few facts that are neither a procedure nor `$`-surface. */
  readonly mesh: Client<R, PC>["$mesh"];
  /** A standard fetch handler — mount it anywhere; see {@link ServerFetch} for the single-port shape. */
  readonly fetch: ServerFetch;
  /**
   * The room host, when custody rides this server's port: what a Node process mounts with
   * `attachRelay` from `@syncmesh/relay-node`, and the key a device pins is its `peerId`.
   */
  readonly custody?: RelayHost;
  /** Bun's socket callbacks for inline custody — the `websocket` half of the single-port recipe. */
  readonly websocket?: BunWebSocketHandlers;
  /** From `.route()` metadata: authority calls are plain request/response, so the spec is too. */
  readonly openapi: (info: { readonly title: string; readonly version: string }) => object;
  /** Where peers dial this node, when it serves custody; absent when it only answers HTTP. */
  readonly serving?: Serving;
  /** Stops the watchdogs, the rooms it serves, then the mesh. */
  readonly stop: () => Promise<void>;
};

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
  const procedures = createHandler(handlerOptions);

  const stops = (watchdogs ?? []).map((start) => start(client));
  // custody on its own port is the relay as it was; custody with none rides this fetch
  const serving =
    custody === undefined || custody.port === undefined ? undefined : await serveCustody(custody);
  const inline: InlineCustody | undefined =
    custody === undefined || custody.port !== undefined ? undefined : await inlineCustody(custody);

  // custody first, because an upgrade and a room's GET are the only requests that are not a
  // procedure call, and both are told apart by the request alone
  // SAFETY: the two overloads differ only in whether Bun's server is passed, and `take` answers
  // `undefined` only on the path that took an upgrade, which needs it
  const fetch = ((request: Request, upgrading?: Upgrading) =>
    inline?.take(request, upgrading) ?? procedures(request)) as ServerFetch;

  // from the contract, so the spec and a contract.json a build writes cannot disagree
  const openapi = (info: { readonly title: string; readonly version: string }) =>
    openApi(contractJson(options.procedures), info);

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
      await inline?.stop();
      await client.$close();
    },
  });
  if (serving !== undefined) Object.assign(served, { serving });
  if (inline !== undefined)
    Object.assign(served, { custody: inline.host, websocket: inline.websocket });
  // SAFETY: every member `Server` names beyond `Client` is assigned right here
  return served as Server<R, PC>;
}

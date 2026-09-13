import type { Mesh } from "@syncmesh/client";
import type { ColumnsMap, PartitionTree, PresenceMap, Roles } from "@syncmesh/schema";

import type { Api, Router } from "./api.js";
import type { AppOptions } from "./app.js";

import { createApp } from "./app.js";

/**
 * One noun (book ch. 8, rule 1): the client **is** the api. Procedures sit at the top level —
 * `client.products.list(…)` — and the machinery an app occasionally needs sits beside them
 * under `$`, which is a spelling no procedure can collide with.
 *
 * Three tiers, three spellings: `$` is framework surface, `~` is adapter surface, and a plain
 * name is the app's own procedure. That is what makes the collision impossible by construction
 * rather than by a reserved-words list somebody has to maintain.
 *
 * @example
 * export const client = await createClient({
 *   schema,
 *   procedures: router,
 *   identity: await loadIdentity(),
 *   driver: bunSqliteDriver("rounds.db"),
 *   transports: [relayTransport({ dial: webSocketDial(RELAY_URL) })],
 * });
 *
 * const products = client.products.list({ shopId });      // a descriptor, inert until read
 * await client.$flush();                                   // the machinery, when it is needed
 */
export type Client<R extends Router, PC extends PresenceMap = Record<string, never>> = Api<R> & {
  /** The write ledger: what a write became, who holds it, what overruled it (ch. 10). */
  readonly $operations: Mesh<"sqlite", PC>["operations"];
  /** What is stuck and why, with the operator's idempotent nudge (ch. 18). */
  readonly $recovery: Mesh<"sqlite", PC>["recovery"];
  /** Per-source conditions and one overall health (ch. 18). */
  readonly $status: Mesh<"sqlite", PC>["status"];
  /** The radios at runtime: a settings toggle adds one, removing one removes a route (ch. 16). */
  readonly $transports: Mesh<"sqlite", PC>["transports"];
  /** Who this device can reach, over what (ch. 17). */
  readonly $peers: Mesh<"sqlite", PC>["peers"];
  /** Routes that span hops: the next hop to a service, and how far (ch. 17). */
  readonly $routes: Mesh<"sqlite", PC>["routes"];
  /** Bytes outside the log, content-addressed and verified at both ends (ch. 12). */
  readonly $blobs: Mesh<"sqlite", PC>["blobs"];
  /** How a device's events get admitted at all (ch. 14). */
  readonly $grants: Mesh<"sqlite", PC>["grants"];
  /** Who is calling, until when, and how to end it (ch. 14). */
  readonly $auth: Mesh<"sqlite", PC>["auth"];
  /** Local-only data with no replication promise (ch. 8). */
  readonly $drafts: Mesh<"sqlite", PC>["drafts"];
  /** The ephemeral tier, pinned to an instance (ch. 16). */
  readonly $presence: Mesh<"sqlite", PC>["presence"];
  /** Leak counters and the flight deck (ch. 12). */
  readonly $inspect: Mesh<"sqlite", PC>["inspect"];
  /** What the manifest declares, for anything that enumerates tables and kinds (ch. 6). */
  readonly $schema: Mesh<"sqlite", PC>["schema"];
  /**
   * Read-only SQL over the mesh's own connection; `undefined` over a bare event store (ch. 9).
   *
   * `all` with no `run` beside it. Every procedure above is the way to *write* — a statement
   * through a handle becomes a signed event — and this is the one way to read that cannot
   * accidentally become one.
   */
  readonly $query: Mesh<"sqlite", PC>["query"];
  /** Which devices an account has vouched for (ch. 14). */
  readonly $accounts: Mesh<"sqlite", PC>["accounts"];
  /** Every transport's queue has run out. Never rejects, never stops early (ch. 13). */
  readonly $flush: () => Promise<void>;
  /**
   * Stops the transports, then closes what the client opened. Not required for durability —
   * every acknowledged write already committed — just polite to the last batch (ch. 13).
   */
  readonly $close: () => Promise<void>;
  /**
   * The mesh underneath, for the few facts that are neither a procedure nor `$`-surface:
   * `ready`, `settled`, `requestGrant`, `history`, `engine`. Everything an app *reads or
   * writes* is a procedure.
   */
  readonly $mesh: Mesh<"sqlite", PC>;
};

export async function createClient<
  R extends Router,
  P extends PartitionTree,
  const RS extends Roles<P>,
  C extends ColumnsMap,
  PC extends PresenceMap = Record<string, never>,
>(options: AppOptions<R, P, RS, C, PC>): Promise<Client<R, PC>> {
  const { api, mesh } = await createApp(options);
  // assigned onto the api rather than spread into a fresh object: `api` is a walked tree of
  // callables, and spreading one would copy the leaves off their own group objects
  // SAFETY: every `$` key the Client type names is assigned right here, and `api` is already
  // `Api<R>` — the assertion states the union the assignment just built
  const client = Object.assign(api, {
    $operations: mesh.operations,
    $recovery: mesh.recovery,
    $status: mesh.status,
    $transports: mesh.transports,
    $peers: mesh.peers,
    $routes: mesh.routes,
    $blobs: mesh.blobs,
    $grants: mesh.grants,
    $auth: mesh.auth,
    $drafts: mesh.drafts,
    $presence: mesh.presence,
    $inspect: mesh.inspect,
    $schema: mesh.schema,
    $query: mesh.query,
    $accounts: mesh.accounts,
    $flush: mesh.flush,
    $close: mesh.stop,
    $mesh: mesh,
  }) as Client<R, PC>;
  return client;
}

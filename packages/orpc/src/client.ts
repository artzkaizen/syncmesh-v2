import type { Mesh, MeshStatus } from "@syncmesh/client";
import type { ColumnsMap, PresenceMap } from "@syncmesh/schema";

import { createMesh } from "@syncmesh/client";
import { panic } from "@syncmesh/result";

import type { Api, ApiMesh, Router } from "./api.js";
import type { ClientOptions } from "./options.js";

import { meshApi } from "./api.js";
import { flatten, named } from "./options.js";

/**
 * One noun (book ch. 8, rule 1): the client **is** the api. Procedures sit at the top level —
 * `client.products.list(…)` — and the machinery an app occasionally needs sits beside them
 * under `$`, which is a spelling no procedure can collide with.
 *
 * Three tiers, three spellings: `$` is framework surface, `~` is adapter surface, and a plain
 * name is the app's own procedure. That is what makes the collision impossible by construction
 * rather than by a reserved-words list somebody has to maintain.
 *
 * **The client is a value, and the database opens underneath it.** `createClient` returns at
 * once; `$ready` is when the mesh exists. Until then a read is pending — the same
 * `hasAnswered: false` a screen already draws for — a write commits when it can, and `$status`
 * says `opening`. This is what puts the shell on screen in the first frame on a phone, where
 * opening SQLite is I/O that used to stand between launch and anything at all.
 *
 * @example
 * export const client = createClient({
 *   schema,
 *   procedures: router,
 *   driver: bunSqliteDriver("rounds.db"),
 *   transports: [relayTransport({ dial: webSocketDial(RELAY_URL) })],
 * });
 *
 * const products = client.products.list({ shopId });      // a descriptor, inert until read
 * await client.$ready;                                     // the mesh, when a script needs it
 * await client.$flush();                                   // the machinery, when it is needed
 */
export type Client<R extends Router, PC extends PresenceMap = Record<string, never>> = Api<R> & {
  /**
   * The mesh exists. Rejects if it never will — no database, no key, whatever `createMesh`
   * refused for — with the reason, and every `$` surface below throws the same reason after.
   *
   * A script awaits this before it reads `$mesh`; a screen never has to, because every read it
   * makes is pending until then and every write it makes waits for it.
   */
  readonly $ready: Promise<void>;
  /** The write ledger: what a write became, who holds it, what overruled it (ch. 10). */
  readonly $operations: Mesh<"sqlite", PC>["operations"];
  /** What is stuck and why, with the operator's idempotent nudge (ch. 18). */
  readonly $recovery: Mesh<"sqlite", PC>["recovery"];
  /** Per-source conditions and one overall health — `opening` before there is a mesh (ch. 18). */
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
   * writes* is a procedure. Throws before `$ready`.
   */
  readonly $mesh: Mesh<"sqlite", PC>;
};

/** What `$status` says before there is a mesh to ask: no sources, and the one word for it. */
const OPENING: MeshStatus = { health: "opening", sources: new Map() };

/**
 * The `$` surfaces that are the mesh's, reached through one getter each so that every one of
 * them answers the same way before `$ready`: with the reason there is no mesh, not `undefined`.
 */
const MESH_SURFACES = [
  "operations",
  "recovery",
  "transports",
  "peers",
  "routes",
  "blobs",
  "grants",
  "auth",
  "drafts",
  "presence",
  "inspect",
  "query",
  "accounts",
] as const;

export function createClient<
  R extends Router,
  C extends ColumnsMap,
  PC extends PresenceMap = Record<string, never>,
>(options: ClientOptions<R, C, PC>): Client<R, PC> {
  let mesh: Mesh<"sqlite", PC> | undefined;
  /** The same mesh under the narrower name the api binds to, built once rather than per call. */
  let bound: ApiMesh<PC> | undefined;
  let refused: Error | undefined;
  const watching = new Set<() => void>();

  const opening = (async (): Promise<void> => {
    // `procedures` and `link` are the client's own and pass through `flatten` unchanged, so the
    // api above was built from them already; what `createMesh` takes is everything else
    const { procedures: _procedures, link: _link, ...meshOptions } = flatten(await named(options));
    const opened = await createMesh(meshOptions);
    // the tagged error travels as the cause, so a caller who does want to branch — "storage
    // damaged, rejoin?" — still can, without every other caller unwrapping to reach it
    if (opened.isErr())
      return panic(`the app could not open: ${opened.error.message}`, opened.error);
    mesh = opened.value;
    bound = { ...mesh, self: mesh.engine.peerId };
  })();
  const ready = opening.then(
    () => {
      // `opening` → whatever the mesh says: the one change every status watcher is waiting on
      for (const listener of watching) listener();
    },
    (cause: unknown) => {
      refused = cause instanceof Error ? cause : new Error(String(cause));
      throw refused;
    },
  );
  // observed here so a refusal is never an unhandled rejection — a screen reads it off `$status`
  // and never awaits `$ready` at all, and it still rejects for the script that does
  ready.catch(() => undefined);

  /** The mesh, or the sentence for why there is none — never `undefined`. */
  const held = (): Mesh<"sqlite", PC> => {
    if (mesh !== undefined) return mesh;
    throw new Error(
      refused === undefined
        ? "the mesh has not opened yet — await `client.$ready` before reaching past the api"
        : `the mesh could not open: ${refused.message}`,
    );
  };

  const carries = {};
  if (options.link !== undefined) Object.assign(carries, { link: options.link });
  const api = meshApi<R, PC>(
    { current: () => bound, ready, schema: options.schema },
    options.procedures,
    carries,
  );

  /** `$status` before and after: `opening` with no sources, then the mesh's own reading. */
  const status: Mesh<"sqlite", PC>["status"] = {
    get: () => mesh?.status.get() ?? OPENING,
    subscribe: (listener) => {
      if (mesh !== undefined) return mesh.status.subscribe(listener);
      watching.add(listener);
      let off: (() => void) | undefined;
      void ready.then(
        () => {
          if (watching.has(listener)) off = held().status.subscribe(listener);
        },
        () => undefined,
      );
      return () => {
        watching.delete(listener);
        off?.();
      };
    },
  };

  // defined as getters rather than assigned: the values do not exist yet, and a getter is what
  // lets `client.$grants` be the mesh's the moment there is one and a sentence until then
  const surfaces: PropertyDescriptorMap = {
    $ready: { enumerable: true, value: ready },
    $status: { enumerable: true, value: status },
    $schema: { enumerable: true, value: options.schema },
    $flush: {
      enumerable: true,
      value: () =>
        ready.then(
          () => held().flush(),
          () => undefined,
        ),
    },
    $close: {
      enumerable: true,
      value: () =>
        ready.then(
          () => held().stop(),
          () => undefined,
        ),
    },
    $mesh: { enumerable: true, get: () => held() },
  };
  for (const name of MESH_SURFACES)
    surfaces[`$${name}`] = { enumerable: true, get: () => held()[name] };
  // SAFETY: every `$` key the Client type names is defined right here, and `api` is already
  // `Api<R>` — the assertion states the union the definitions just built
  return Object.defineProperties(api, surfaces) as Client<R, PC>;
}

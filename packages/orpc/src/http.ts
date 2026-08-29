import type { Result as ResultType } from "@syncmesh/result";

import { Result } from "@syncmesh/result";

import type { Api, AuthorityLink, ProcedureDef, Router } from "./api.js";

/**
 * The same procedures, over HTTP.
 *
 * A browser has no SQLite — `sqlite-wasm` over OPFS is unbuilt (E04) — so a web app cannot hold a
 * partition and run its reads locally. What it can do is call the very procedures a device runs
 * in-process, against a mesh on the server that *does* hold the partition and *is* on the relay.
 * One definition, two ways of reaching it, and the app's call sites read the same either way.
 *
 * This is not a second RPC system: it is one `POST` carrying a path and an input, which is the
 * least a remote call can be. D10's "syncmesh does not ship an RPC system" survives it — there is
 * no router on the wire, no handler map, no codec, and nothing on the relay.
 */

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion -- this file *is* the wire boundary: a path names a leaf whose shape only `Api<R>` knows, JSON arrives untyped, and every narrowing here is the parse that restores it */

/** One call as it crosses: the procedure's path, and its input. */
export interface CallBody {
  readonly path: string;
  readonly input?: unknown;
}

const isDef = (node: ProcedureDef | Router): node is ProcedureDef =>
  "kind" in node &&
  (node.kind === "query" || node.kind === "mutation" || node.kind === "authority");

/** Walks `books.list` to the procedure it names, or `undefined` where the router has no such leaf. */
export const findProcedure = (router: Router, path: string): ProcedureDef | undefined => {
  let node: ProcedureDef | Router | undefined = router;
  for (const step of path.split(".")) {
    if (node === undefined || isDef(node)) return undefined;
    node = node[step];
  }
  return node !== undefined && isDef(node) ? node : undefined;
};

export interface HandlerOptions<R extends Router> {
  readonly procedures: R;
  /** The api this server runs calls against — `createApp`'s, bound to the server's own mesh. */
  readonly api: Api<R>;
}

/**
 * A `fetch` handler for one api. Give it the request; it answers the call.
 *
 * A query is **run once** and its rows returned. There is no subscription here on purpose: a live
 * query is a fold on the device that holds the log, and pretending otherwise over HTTP would be
 * promising a freshness this cannot keep.
 */
export function createHandler<R extends Router>(options: HandlerOptions<R>) {
  const { procedures, api } = options;

  return async (request: Request): Promise<Response> => {
    const body = await Result.tryPromise({
      try: () => request.json() as Promise<CallBody>,
      catch: () => new Error("the request body is not JSON"),
    });
    if (body.isErr()) return Response.json({ error: body.error.message }, { status: 400 });

    const { path, input } = body.value;
    const def = findProcedure(procedures, path);
    if (def === undefined) return Response.json({ error: `no procedure ${path}` }, { status: 404 });

    const call = leafAt(api, path);
    if (call === undefined) return Response.json({ error: `no call ${path}` }, { status: 404 });

    const ran = await Result.tryPromise({
      try: async () => {
        const made = call(input);
        return def.kind === "query" && "run" in made ? made.run() : made;
      },
      catch: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    if (ran.isErr()) return Response.json({ error: ran.error.message }, { status: 500 });

    // a mutation already hands back a Result; a query hands back rows
    const value = ran.value;
    if (isResult(value))
      return value.isErr()
        ? Response.json({ error: value.error.message }, { status: 422 })
        : Response.json({ data: value.value });
    return Response.json({ data: value });
  };
}

/** What a leaf hands back: rows behind a `run()` for a query, or a `Result` for anything else. */
type Leaf = (input: unknown) => { readonly run: () => Promise<unknown> } | Promise<unknown>;

const leafAt = (api: object, path: string): Leaf | undefined => {
  let node: unknown = api;
  for (const step of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[step];
  }
  return typeof node === "function" ? (node as Leaf) : undefined;
};

const isResult = (value: unknown): value is ResultType<unknown, Error> =>
  value !== null && typeof value === "object" && "isErr" in value;

/**
 * Sends a call to a {@link createHandler} endpoint. What a browser hands `createApp`'s `link`,
 * and what makes an `authority` procedure reach the server that implements it.
 */
export const httpLink =
  (url: string, init?: RequestInit): AuthorityLink =>
  async (path, input) => {
    const sent = await Result.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          ...init,
          method: "POST",
          headers: { "content-type": "application/json", ...init?.headers },
          body: JSON.stringify({ path, input } satisfies CallBody),
        });
        const payload = (await response.json()) as { data?: unknown; error?: string };
        if (!response.ok) throw new Error(payload.error ?? `${path} failed: ${response.status}`);
        return payload.data;
      },
      catch: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    return sent;
  };
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion */

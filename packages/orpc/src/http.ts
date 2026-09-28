import type { Handle } from "@syncmesh/client";
import type { Result as ResultType, RevivableTagged, TaggedCatalog } from "@syncmesh/result";

import {
  Result,
  TaggedError,
  createTaggedCatalog,
  isTaggedError,
  serializeTagged,
} from "@syncmesh/result";

import type {
  Api,
  AuthorityDef,
  AuthorityHandlers,
  AuthorityLink,
  DeclaredErrors,
  ProcedureDef,
  Router,
} from "./api.js";

import { validate } from "./api.js";
import { NoBodyBound } from "./errors.js";

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
  /**
   * The gates: the router's `.authority()` leaves mirrored as bodies (book ch. 19), and the
   * handle they run with. A server whose router declares no gates omits this.
   */
  readonly gate?: {
    readonly handlers: AuthorityHandlers<R>;
    /** The replica this call is about, from the call's own input — scope is input (ch. 3). */
    readonly handle: (input: unknown) => Handle;
  };
}

/** One thrower per declared error name; a thrown one crosses as its own tag and revives typed. */
const throwersOf = (declared: DeclaredErrors = {}) =>
  Object.fromEntries(
    Object.entries(declared).map(([tag, spec]) => [
      tag,
      (over?: { readonly message?: string }) =>
        new (TaggedError(tag))({ message: over?.message ?? spec.message ?? tag }),
    ]),
  );

/**
 * A `fetch` handler for one api. Give it the request; it answers the call.
 *
 * A query is **run once** and its rows returned. There is no subscription here on purpose: a live
 * query is a fold on the device that holds the log, and pretending otherwise over HTTP would be
 * promising a freshness this cannot keep.
 */
export function createHandler<R extends Router>(options: HandlerOptions<R>) {
  const { procedures, api, gate } = options;

  /** A gate's body, run with the parsed input and its declared errors; the mirror is complete by type. */
  const decide = async (path: string, def: AuthorityDef<never, unknown>, input: unknown) => {
    const body = gate === undefined ? undefined : leafAt(gate.handlers, path);
    if (body === undefined || gate === undefined)
      return Result.err(
        new NoBodyBound({
          path,
          message: `${path} is a gate, and this server binds no body for it`,
        }),
      );
    const parsed = validate<never>(def.schema, input);
    if (parsed.isErr()) return parsed;
    // the handle resolves lazily: a gate that reads no tables never opens one
    const context = {
      input: parsed.value,
      errors: throwersOf(def.errors),
      get db() {
        return gate.handle(parsed.value).db;
      },
      get read() {
        return gate.handle(parsed.value).read;
      },
    };
    const answered = await Result.tryPromise({
      try: async () => (body as (c: unknown) => unknown)(context),
      catch: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    if (answered.isErr() || def.output === undefined) return answered;
    return validate<unknown>(def.output, answered.value);
  };

  return async (request: Request): Promise<Response> => {
    const body = await Result.tryPromise({
      try: () => request.json() as Promise<CallBody>,
      catch: () => new Error("the request body is not JSON"),
    });
    if (body.isErr()) return Response.json({ error: body.error.message }, { status: 400 });

    const { path, input } = body.value;
    const def = findProcedure(procedures, path);
    if (def === undefined) return Response.json({ error: `no procedure ${path}` }, { status: 404 });

    if (def.kind === "authority" && gate !== undefined) {
      const decided = await decide(path, def, input);
      return decided.isErr()
        ? Response.json({ error: wireError(decided.error) }, { status: 422 })
        : Response.json({ data: decided.value });
    }

    const call = leafAt(api, path);
    if (call === undefined) return Response.json({ error: `no call ${path}` }, { status: 404 });

    const ran = await Result.tryPromise({
      try: async () => {
        const made = call(input);
        // the rows, not the `Result` awaiting the descriptor would give: a query crosses as `{ data }`
        return def.kind === "query" && "~mesh" in made ? made["~mesh"].run() : made;
      },
      catch: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    if (ran.isErr()) return Response.json({ error: wireError(ran.error) }, { status: 500 });

    // a mutation already hands back a Result; a query hands back rows
    const value = ran.value;
    if (isResult(value))
      return value.isErr()
        ? Response.json({ error: wireError(value.error) }, { status: 422 })
        : Response.json({ data: value.value });
    return Response.json({ data: value });
  };
}

/**
 * The failure as the wire carries it: `{ _tag, message, ...fields }` for a tagged error, so the
 * caller revives the class it declared (book ch. 5); a bare `Error` crosses as its message under
 * the one tag nothing should match on.
 */
const wireError = (error: Error): Record<string, unknown> =>
  isTaggedError(error)
    ? serializeTagged(error)
    : { _tag: "UnhandledException", message: error.message };

/** What a leaf hands back: rows behind a `run()` for a query, or a `Result` for anything else. */
type Leaf = (
  input: unknown,
) => { readonly "~mesh": { readonly run: () => Promise<unknown> } } | Promise<unknown>;

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

export interface HttpLinkOptions extends RequestInit {
  /**
   * The tagged error classes this caller declares: a `{ _tag, ...fields }` failure from the
   * server revives into the matching class, so `matchError` after a network hop reads like
   * `matchError` in-process. Tags outside the catalog arrive as `ForeignTagged`.
   */
  readonly errors?: readonly RevivableTagged[];
}

/**
 * Sends a call to a {@link createHandler} endpoint. What a browser hands `createApp`'s `link`,
 * and what makes an `authority` procedure reach the server that implements it.
 */
export const httpLink = (url: string, options: HttpLinkOptions = {}): AuthorityLink => {
  const { errors, ...init } = options;
  const catalog: TaggedCatalog = createTaggedCatalog(errors ?? []);
  return async (path, input) => {
    const sent = await Result.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          ...init,
          method: "POST",
          headers: { "content-type": "application/json", ...init.headers },
          body: JSON.stringify({ path, input } satisfies CallBody),
        });
        const payload = (await response.json()) as { data?: unknown; error?: unknown };
        if (!response.ok)
          throw (
            catalog.revive(payload.error) ??
            new Error(
              typeof payload.error === "string"
                ? payload.error
                : `${path} failed: ${response.status}`,
            )
          );
        return payload.data;
      },
      catch: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    return sent;
  };
};
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion */

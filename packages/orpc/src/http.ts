import type { AnyMetaPlugin } from "@orpc/contract";
import type { AnyRouter } from "@orpc/server";
import type { Handle } from "@syncmesh/client";
import type { Result as ResultType, RevivableTagged, TaggedCatalog } from "@syncmesh/result";

import { ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import {
  Result,
  TaggedError,
  createTaggedCatalog,
  isTaggedError,
  omitUndefined,
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
import type { IdempotencyStore, StoredAnswer } from "./idempotency.js";

import { validate } from "./api.js";
import { errorMap, kindMeta, leaves, routeMeta } from "./contract.js";
import { NoBodyBound } from "./errors.js";
import { REQUEST_ID_HEADER, memoryIdempotency } from "./idempotency.js";

/**
 * The same procedures, over HTTP — as oRPC serves them (D10: procedures are oRPC, and syncmesh
 * ships no RPC system of its own).
 *
 * A browser has no SQLite, so a web app cannot hold a partition and run its reads locally. What
 * it can do is call the very procedures a device runs in-process, against a mesh on the server
 * that *does* hold the partition and *is* on the relay. One definition, two ways of reaching it.
 *
 * What is syncmesh's here is thin and stated: the router's leaves become oRPC procedures whose
 * bodies run the api or the gate; a failure crosses as an `ORPCError` whose code is the tag and
 * whose data is the fields, so the class the caller declared revives on the other side; and a
 * request id makes a retried call answer from what was kept rather than run twice.
 */

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion -- this file *is* the wire boundary: a path names a leaf whose shape only `Api<R>` knows, JSON arrives untyped, and every narrowing here is the parse that restores it */

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
  /**
   * Where answers are kept by request id, so a retried call is answered rather than re-run.
   * Memory when absent — enough for a retry after a timeout, gone with the process.
   */
  readonly idempotency?: IdempotencyStore;
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

/** The HTTP status a failure crosses under, by the tag this layer mints; a gate's own tags are 422. */
const STATUS_BY_TAG = new Map([
  ["InputInvalid", 400],
  ["SchemaNotSynchronous", 500],
  ["NothingWritten", 422],
  ["AuthorityUnreachable", 503],
  ["NoBodyBound", 501],
  ["UnhandledException", 500],
]);

/**
 * A declared or minted failure as the `ORPCError` the wire carries: the tag is the code, the
 * fields the data. The HTTP status follows the code (oRPC v2), through the handler's status map.
 */
const wireError = (error: Error): ORPCError<string, unknown> => {
  if (!isTaggedError(error)) return new ORPCError("UnhandledException", { message: error.message });
  const { _tag, message, ...fields } = serializeTagged(error);
  const code = String(_tag);
  return new ORPCError(code, {
    message: typeof message === "string" ? message : code,
    data: fields,
  });
};

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

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/** The kept answer's headers: its content type, when it had one. */
const headersOf = (answer: StoredAnswer): Headers => {
  const headers = new Headers();
  if (answer.contentType !== null) headers.set("content-type", answer.contentType);
  return headers;
};

/** A `Response` rebuilt from what was kept, marked so a caller can tell a replay from a first answer. */
const replayed = (answer: StoredAnswer): Response => {
  const headers = headersOf(answer);
  headers.set("x-syncmesh-replayed", "true");
  return new Response(answer.body, { status: answer.status, headers });
};

/** The fetch handler, with the one in-process door beside it. */
export interface ProcedureHandler {
  (request: Request): Promise<Response>;
  /**
   * The same call without HTTP: what a server-side function that already holds the server
   * uses instead of posting to itself. Answers the `Result` the leaf answered, errors as the
   * classes they are.
   */
  readonly call: (path: string, input: unknown) => Promise<ResultType<unknown, Error>>;
}

/**
 * A `fetch` handler for one api, served by oRPC's `RPCHandler`: `POST /<group>/<leaf>` with the
 * input as the body, which is what {@link httpLink} sends.
 *
 * A query is **run once** and its rows returned. There is no subscription here on purpose: a live
 * query is a fold on the device that holds the log, and pretending otherwise over HTTP would be
 * promising a freshness this cannot keep.
 */
export function createHandler<R extends Router>(options: HandlerOptions<R>): ProcedureHandler {
  const { procedures, api, gate } = options;
  const store = options.idempotency ?? memoryIdempotency();

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
      catch: asError,
    });
    if (answered.isErr() || def.output === undefined) return answered;
    return validate<unknown>(def.output, answered.value);
  };

  /** One call, in-process: the leaf's own answer as a `Result`, whichever kind of leaf it is. */
  const call = async (path: string, input: unknown): Promise<ResultType<unknown, Error>> => {
    const def = findProcedure(procedures, path);
    if (def === undefined) return Result.err(new Error(`no procedure ${path}`));
    if (def.kind === "authority" && gate !== undefined) return decide(path, def, input);
    const leaf = leafAt(api, path);
    if (leaf === undefined) return Result.err(new Error(`no call ${path}`));
    const ran = await Result.tryPromise({
      try: async () => {
        const made = leaf(input);
        // the rows, not the `Result` awaiting the descriptor would give: a query crosses as rows
        return def.kind === "query" && "~mesh" in made ? made["~mesh"].run() : made;
      },
      catch: asError,
    });
    if (ran.isErr()) return ran;
    return isResult(ran.value) ? ran.value : Result.ok(ran.value);
  };

  // the oRPC router: one procedure per leaf, each carrying the leaf's route and its errors so
  // an oRPC client built from the contract agrees with this server about both. Input is
  // validated by `call` above rather than by oRPC, so a refused input crosses as `InputInvalid`
  // — the tag every in-process caller already branches on — and not as a different code here
  const implemented: Record<string, unknown> = {};
  const declaredStatus: Record<string, number> = {};
  for (const [path, def] of leaves(procedures)) {
    const plugins: AnyMetaPlugin[] = [
      kindMeta({ kind: def.kind, via: def.kind === "authority" ? def.via : def.kind }),
    ];
    if (def.route !== undefined) plugins.push(routeMeta(def.route));
    const declared = def.kind === "authority" ? def.errors : undefined;
    for (const tag of Object.keys(declared ?? {})) declaredStatus[tag] = 422;
    const procedure = os
      .meta(...plugins)
      .errors(errorMap(declared ?? {}))
      .handler(async ({ input }) => {
        const answered = await call(path, input);
        if (answered.isErr()) throw wireError(answered.error);
        return answered.value;
      });
    let node = implemented;
    const steps = path.split(".");
    for (const step of steps.slice(0, -1)) {
      node[step] ??= {};
      node = node[step] as Record<string, unknown>;
    }
    node[steps[steps.length - 1] ?? path] = procedure;
  }
  const rpc = new RPCHandler(implemented as AnyRouter, {
    errorStatusMap: { ...declaredStatus, ...Object.fromEntries(STATUS_BY_TAG) },
  });

  const answer = async (request: Request): Promise<Response> => {
    const { matched, response } = await rpc.handle(request, { context: {} });
    return matched
      ? response
      : Response.json({ error: "no procedure at this path" }, { status: 404 });
  };

  /** Calls in flight by request id: a duplicate that arrives mid-run waits for the first. */
  const running = new Map<string, Promise<StoredAnswer>>();
  const fetch = async (request: Request): Promise<Response> => {
    const id = request.headers.get(REQUEST_ID_HEADER);
    if (id === null) return answer(request);
    const kept = await store.get(id);
    if (kept !== undefined) return replayed(kept);
    const inflight = running.get(id);
    if (inflight !== undefined) return replayed(await inflight);
    const settling = answer(request)
      .then(async (response) => {
        const stored: StoredAnswer = {
          status: response.status,
          contentType: response.headers.get("content-type"),
          body: await response.text(),
        };
        await store.put(id, stored);
        return stored;
      })
      .finally(() => running.delete(id));
    running.set(id, settling);
    const stored = await settling;
    return new Response(stored.body, { status: stored.status, headers: headersOf(stored) });
  };

  return Object.assign(fetch, { call });
}

export interface HttpLinkOptions {
  /**
   * The tagged error classes this caller declares: a failure whose code is one of their tags
   * revives into the class, so `matchError` after a network hop reads like `matchError`
   * in-process. Tags outside the catalog arrive as `ForeignTagged`.
   */
  readonly errors?: readonly RevivableTagged[];
  /** Headers on every call — a session cookie, a bearer token. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The `fetch` to send with; the platform's when absent. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** The failure a call came back with, as the class this caller declared for its tag. */
const revive = (catalog: TaggedCatalog, cause: unknown): Error => {
  if (cause instanceof ORPCError) {
    const data = cause.data;
    const fields =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    return (
      catalog.revive({ ...fields, _tag: cause.code, message: cause.message }) ??
      new Error(cause.message)
    );
  }
  return asError(cause);
};

/**
 * Sends a call to a {@link createHandler} endpoint over oRPC's `RPCLink`. What a browser hands
 * `createClient`'s `link`, and what makes an `authority` procedure reach the server that
 * implements it. The request id, when the call carries one, rides `x-syncmesh-request-id`.
 */
export const httpLink = (url: string, options: HttpLinkOptions = {}): AuthorityLink => {
  const catalog = createTaggedCatalog(options.errors ?? []);
  const link = new RPCLink<{ readonly requestId?: string }>(
    omitUndefined({
      origin: url,
      // the request id rides its header only on a call that carries one
      headers: ({ context }: { readonly context: { readonly requestId?: string } }) =>
        omitUndefined({ ...options.headers, [REQUEST_ID_HEADER]: context.requestId }),
      fetch: options.fetch,
    }),
  );
  return (path, input, call = {}) =>
    Result.tryPromise({
      try: () =>
        link.call(path.split("."), input, {
          context: omitUndefined({ requestId: call.requestId }),
        }),
      catch: (cause) => revive(catalog, cause),
    });
};
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion */

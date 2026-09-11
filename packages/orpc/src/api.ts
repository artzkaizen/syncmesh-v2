import type { Handle, Mesh } from "@syncmesh/client";
import type { Live, Runnable } from "@syncmesh/drizzle";
import type { EventId } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { Output, PresenceMap, StandardSchemaV1 } from "@syncmesh/schema";
import type { TxReceipt } from "@syncmesh/storage";

import { Result } from "@syncmesh/result";

/**
 * The one surface an app touches (D26): `api.books.list(…)` and `api.books.create(…)`, never a
 * handle and never Drizzle. Drizzle appears inside a handler and nowhere else.
 *
 * A read and a write are asymmetric underneath, and deliberately: a query **is** a subscribable
 * expression, so its handler returns the Drizzle query un-run — `live()` reads its SQL to learn
 * which tables invalidate it, and awaiting it would leave the subscription nothing to key on. A
 * mutation **is** a procedure, so its handler runs, inside one transaction, as one event.
 */

/** What a mutation hands back: what the handler returned, and the event the transaction became. */
export interface WriteResult<T> {
  /** `"<author>-<seq>"`: the handle every later fact about this write is looked up by. */
  readonly eventId: EventId;
  readonly data: T;
}

/** Anything a call can fail with; a procedure's own declared errors ride the same channel. */
export type CallError = Error;

/**
 * A read that has not run. Inert on purpose — building one in a component body is free, and
 * `useLiveQuery` decides when it executes.
 */
export interface QueryCall<T> {
  readonly kind: "query";
  /** `"books.list"` — the name a devtool shows, and half the subscription's identity. */
  readonly path: string;
  /** Identity: the path and the input. Two renders that ask the same question share one subscription. */
  readonly key: string;
  /** Builds the query, un-run — a one-shot read, and what `live` subscribes. */
  readonly run: () => Runnable<T>;
  /** The subscription: re-runs on every fold batch touching one of the query's tables. */
  readonly live: () => Live<T>;
  /**
   * Every source that could still fill this scope has finished its first pass — what separates
   * "no books" from "the relay has not answered yet" (RFC-0019).
   */
  readonly settled: () => Promise<void>;
}

export interface QueryDef<I, T> {
  readonly kind: "query";
  readonly schema?: StandardSchemaV1;
  readonly route?: RouteMeta;
  readonly run: (args: { readonly input: I; readonly mesh: Handle }) => Runnable<T>;
}

export interface MutationDef<I, T> {
  readonly kind: "mutation";
  readonly schema?: StandardSchemaV1;
  readonly route?: RouteMeta;
  readonly run: (args: { readonly input: I; readonly mesh: Handle }) => Promise<T> | T;
}

/** HTTP/OpenAPI metadata and nothing else (book ch. 7): the method describes HTTP, never transactions. */
export interface RouteMeta {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path?: string;
  readonly tags?: readonly string[];
}

/** The failures a gate declares by name; each crosses the wire as its own tag and revives typed. */
export type DeclaredErrors = Readonly<Record<string, { readonly message?: string }>>;

/**
 * A call that **cannot** run on this device: it needs other tenants' rows, the real clock, or the
 * outside world (D10's test for when a procedure should exist at all). The handler lives on the
 * server and never reaches the app's bundle — only this declaration does: the `.authority()`
 * terminal stands where the body would be, and after it no `.handler` exists to call (book ch. 7).
 */
export interface AuthorityDef<I, T> {
  readonly kind: "authority";
  /** Which grammar declared it — a read-shaped gate or the write gate; OpenAPI reads this. */
  readonly via: "query" | "mutation";
  readonly schema?: StandardSchemaV1;
  /** The answer's shape, parsed at the trust boundary — the one payload a client consumes off the wire. */
  readonly output?: StandardSchemaV1;
  readonly errors?: DeclaredErrors;
  readonly route?: RouteMeta;
  /** Phantom, both of them: the shapes exist for inference, and neither is ever called. */
  readonly accepts?: (value: I) => void;
  readonly yields?: (value: never) => T;
}

/**
 * Sends one authority call and returns what came back — an HTTP client, a queue, a test double.
 *
 * The input arrives already validated against the procedure's schema; what it is beyond that is
 * the contract's business and not this transport's, which is why it crosses as an opaque value.
 */
/* oxlint-disable anti-slop/no-unknown-parameters -- the serialisation boundary: the schema has already run, and a link that named the shape could carry only one procedure */
export type AuthorityLink = (
  path: string,
  input: unknown,
) => Promise<ResultType<unknown, CallError>>;
/* oxlint-enable anti-slop/no-unknown-parameters */

/**
 * The bodiless half of the chain: after `.input()`, `.output(schema)` declares the answer and
 * `.authority()` names who decides. Typestate makes a gate body in shared code unrepresentable —
 * after `.output()` there is no `.handler` to call (book ch. 7).
 */
const gateChain =
  (via: "query" | "mutation", route: RouteMeta | undefined, schema: StandardSchemaV1 | undefined) =>
  <I>() => ({
    output: <O extends StandardSchemaV1>(output: O) => {
      const settled = (errors?: DeclaredErrors): AuthorityDef<I, Output<O>> => {
        const def = { kind: "authority" as const, via, output };
        if (schema !== undefined) Object.assign(def, { schema });
        if (route !== undefined) Object.assign(def, { route });
        if (errors !== undefined) Object.assign(def, { errors });
        return def;
      };
      return {
        authority: () => settled(),
        errors: (errors: DeclaredErrors) => ({ authority: () => settled(errors) }),
      };
    },
  });

export type ProcedureDef =
  | QueryDef<never, unknown>
  | MutationDef<never, unknown>
  | AuthorityDef<never, unknown>;
export interface Router {
  readonly [key: string]: ProcedureDef | Router;
}

/** What a gate's body receives: the parsed input, the caller-shaped handle, its declared errors. */
export interface AuthorityContext<I> {
  readonly input: I;
  /** The server's Drizzle surface, acting as the caller where the server binds one. */
  readonly mesh: Handle;
  /** One thrower per declared error name; the thrown tag crosses the wire and revives typed. */
  readonly errors: Readonly<Record<string, (over?: { readonly message?: string }) => Error>>;
}

/**
 * The router's shape filtered to its `.authority()` leaves — the server's typed mirror (book
 * ch. 19): `satisfies AuthorityHandlers<typeof router>` makes a missing body, an extra body, or
 * a drifted signature a compile error at the object literal, never a deploy surprise.
 */
export type AuthorityHandlers<R extends Router> = {
  readonly [
    K in keyof R as R[K] extends AuthorityDef<never, unknown>
      ? K
      : R[K] extends Router
        ? [keyof AuthorityHandlers<R[K]>] extends [never]
          ? never
          : K
        : never
  ]: R[K] extends AuthorityDef<infer I, infer T>
    ? (context: AuthorityContext<I>) => Promise<T> | T
    : R[K] extends Router
      ? AuthorityHandlers<R[K]>
      : never;
};

/**
 * Validates through Standard Schema, so zod, valibot and arktype all work and none is a
 * dependency. This is the parse at the boundary every caller above it is typed against — the
 * runtime walk in {@link meshApi} erases what `Api<R>` states, and this restores it.
 */
/* oxlint-disable anti-slop/no-unknown-parameters -- the I/O boundary itself: turning an unparsed input into `I` is what these three exist to do, and `Api<R>` types every call site above them */
export const validate = <I>(
  schema: StandardSchemaV1 | undefined,
  input: unknown,
): ResultType<I, Error> => {
  if (schema === undefined) {
    // SAFETY: no schema means the procedure declared no input, so `I` is `void` and this asserts nothing about the value
    const bare = input as I;
    return Result.ok(bare);
  }
  const outcome = schema["~standard"].validate(input);
  if (outcome instanceof Promise)
    return Result.err(new TypeError("an input schema must validate synchronously"));
  if (outcome.issues !== undefined)
    return Result.err(new TypeError(outcome.issues.map((i) => i.message).join("; ")));
  // SAFETY: Standard Schema guarantees `value` is the schema's output once `issues` is absent, and `I` is that output — `query`/`mutation` tie the two together with `Output<S>`
  const parsed = outcome.value as I;
  return Result.ok(parsed);
};

/**
 * A read that runs **on this device**, against local SQLite, with no network in it.
 *
 * Unmarked because it is the ordinary case (D26). What carries a qualifier is
 * {@link authority} — the call that needs a server and therefore fails on a ward with no
 * signal — because that is the one a reader has to notice.
 */
const withRoute = <D extends object>(def: D, route: RouteMeta | undefined): D =>
  route === undefined ? def : Object.assign(def, { route });

const queryHead = (route?: RouteMeta) => ({
  input: <S extends StandardSchemaV1>(schema: S) => ({
    handler: <T>(run: QueryDef<Output<S>, T>["run"]): QueryDef<Output<S>, T> =>
      withRoute({ kind: "query", schema, run }, route),
    ...gateChain("query", route, schema)<Output<S>>(),
  }),
  handler: <T>(run: QueryDef<void, T>["run"]): QueryDef<void, T> =>
    withRoute({ kind: "query", run }, route),
});

const mutationHead = (route?: RouteMeta) => ({
  input: <S extends StandardSchemaV1>(schema: S) => ({
    handler: <T>(run: MutationDef<Output<S>, T>["run"]): MutationDef<Output<S>, T> =>
      withRoute({ kind: "mutation", schema, run }, route),
    ...gateChain("mutation", route, schema)<Output<S>>(),
  }),
  handler: <T>(run: MutationDef<void, T>["run"]): MutationDef<void, T> =>
    withRoute({ kind: "mutation", run }, route),
});

export const query = { ...queryHead(), route: (route: RouteMeta) => queryHead(route) };

/** A write that runs on this device, inside one transaction, as one event. */
export const mutation = { ...mutationHead(), route: (route: RouteMeta) => mutationHead(route) };

/**
 * What `useCan` reads, bound to this api's instance so a component names no mesh and no instance.
 * `@syncmesh/react`'s `CanSource` is satisfied structurally; neither package imports the other.
 */
export interface Permissions {
  readonly can: (what: `${string}.${string}`, row?: never) => boolean;
  readonly grants: {
    /** A grant landed: whatever gated a button may now answer differently. */
    readonly onRegistered: (listener: () => void) => () => void;
  };
}

/**
 * Where each row's write has reached, bound to this api's mesh — `useSyncOf` reads it, and the
 * subscription is what turns a receipt from a reading taken once into one that updates.
 */
export interface SyncSource {
  readonly at: (table: string, key: string) => "local" | "delivered" | "remote" | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

/** What a built leaf hands back: an inert read, or a write already running. */
type ApiLeaf = (
  given: never,
) =>
  | QueryCall<unknown>
  | Promise<ResultType<WriteResult<unknown>, CallError>>
  | Promise<ResultType<unknown, CallError>>;

/** One node of the built surface: a callable leaf, or a group of them. */
type ApiNode = ApiLeaf | { readonly [key: string]: ApiNode };

/** The shape `meshApi` builds: a query becomes a descriptor, a mutation a `Result`-returning call. */
export type Api<R extends Router> = {
  /** `useCan(api.$can, "book.insert")` — the `$` marks framework surface, not a procedure. */
  readonly $can: Permissions;
  /** `useSyncOf(api.$sync, "observation", row.id)` — where that row's write got to. */
  readonly $sync: SyncSource;
} & {
  readonly [K in keyof R]: R[K] extends QueryDef<infer I, infer T>
    ? (input: I) => QueryCall<T>
    : R[K] extends MutationDef<infer I, infer T>
      ? (input: I) => Promise<ResultType<WriteResult<T>, CallError>>
      : R[K] extends AuthorityDef<infer I, infer T>
        ? (input: I) => Promise<ResultType<T, CallError>>
        : R[K] extends Router
          ? Api<R[K]>
          : never;
};

/** A leaf, as opposed to a group: the three kinds the grammar can end in. */
export const isDef = (node: ProcedureDef | Router): node is ProcedureDef =>
  "kind" in node &&
  (node.kind === "query" || node.kind === "mutation" || node.kind === "authority");

/**
 * Binds a router to one mesh and one instance: `api.books.list(…)`, `api.books.create(…)`.
 *
 * Bound at construction rather than resolved from a module-level default, because a device that
 * holds two tenants runs two meshes (D07) and an implicit one would silently write to whichever
 * booted last.
 *
 * @example
 * const mesh = (await createMesh({ … })).unwrap();
 * export const api = meshApi(mesh, { books }, { instance: "org:acme" });
 */
export function meshApi<R extends Router, PC extends PresenceMap = Record<string, never>>(
  mesh: Mesh<"sqlite", PC>,
  router: R,
  options: {
    readonly instance?: string;
    /**
     * Carries the calls this device cannot run. Absent, an `authority` call fails as itself
     * rather than pretending — which is the honest answer on a device with no network
     * configured, and a great deal better than a call that silently does nothing.
     */
    readonly link?: AuthorityLink;
  } = {},
): Api<R> {
  const handle = (): Handle => mesh.on(options.instance).unwrap();

  /* thrown, not returned: a descriptor has no error channel of its own, and the hook has an `error` */
  const runnable = (def: QueryDef<never, unknown>, input: unknown) =>
    def.run({ input: validate<never>(def.schema, input).unwrap(), mesh: handle() });

  const read = (path: string, def: QueryDef<never, unknown>, input: unknown) => ({
    kind: "query" as const,
    path,
    key: JSON.stringify([path, input ?? null]),
    run: () => runnable(def, input),
    live: () => handle().live(runnable(def, input)),
    settled: () => mesh.settled(),
  });

  const write = async (def: MutationDef<never, unknown>, input: unknown) => {
    const parsed = validate<never>(def.schema, input);
    if (parsed.isErr()) return parsed;
    const open = handle();
    let receipt: TxReceipt | undefined;
    const off = open.onCommit((r) => {
      receipt = r;
    });
    // one transaction, so a handler that writes twice is still one event
    const ran = await Result.tryPromise({
      try: () =>
        open.db.transaction(() => Promise.resolve(def.run({ input: parsed.value, mesh: open }))),
      catch: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    off();
    if (ran.isErr()) return ran;
    if (receipt === undefined)
      return Result.err(new Error(`${String(def.kind)} wrote nothing: no event to report`));
    return Result.ok({ eventId: receipt.eventId, data: ran.value });
  };

  const remote = async (path: string, def: AuthorityDef<never, unknown>, input: unknown) => {
    const parsed = validate<never>(def.schema, input);
    if (parsed.isErr()) return parsed;
    if (options.link === undefined)
      return Result.err(new Error(`${path} runs on the authority, and no link was configured`));
    const answered = await options.link(path, parsed.value);
    if (answered.isErr() || def.output === undefined) return answered;
    // the trust boundary: the one payload a client consumes straight off the wire (book ch. 7)
    return validate<unknown>(def.output, answered.value);
  };

  const build = (node: Router, prefix: string): ApiNode => {
    const out: { [key: string]: ApiNode } = {};
    for (const [name, child] of Object.entries(node)) {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      if (!isDef(child)) {
        out[name] = build(child, path);
      } else if (child.kind === "query") {
        out[name] = (given: never) => read(path, child, given);
      } else if (child.kind === "mutation") {
        out[name] = (given: never) => write(child, given);
      } else {
        out[name] = (given: never) => remote(path, child, given);
      }
    }
    return out;
  };

  const permissions: Permissions = {
    can: (what, row) => mesh.can(what, row, options.instance),
    grants: { onRegistered: (listener) => mesh.grants.onRegistered(() => listener()) },
  };
  const sync: SyncSource = {
    at: (table, key) => mesh.syncOf(table, key),
    subscribe: (listener) => mesh.onSyncChange(listener),
  };
  // SAFETY: `build` walks the same router the `Api<R>` mapped type describes, leaf for leaf
  const walked = { ...build(router, ""), $can: permissions, $sync: sync } as Api<R>;
  return walked;
}
/* oxlint-enable anti-slop/no-unknown-parameters */

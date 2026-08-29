import type { Handle, Mesh } from "@syncmesh/client";
import type { Live, Runnable } from "@syncmesh/drizzle";
import type { EventId } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { Output, StandardSchemaV1 } from "@syncmesh/schema";
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
  readonly run: (args: { readonly input: I; readonly mesh: Handle }) => Runnable<T>;
}

export interface MutationDef<I, T> {
  readonly kind: "mutation";
  readonly schema?: StandardSchemaV1;
  readonly run: (args: { readonly input: I; readonly mesh: Handle }) => Promise<T> | T;
}

export type ProcedureDef = QueryDef<never, unknown> | MutationDef<never, unknown>;
export interface Router {
  readonly [key: string]: ProcedureDef | Router;
}

/**
 * Validates through Standard Schema, so zod, valibot and arktype all work and none is a
 * dependency. This is the parse at the boundary every caller above it is typed against — the
 * runtime walk in {@link meshApi} erases what `Api<R>` states, and this restores it.
 */
/* oxlint-disable anti-slop/no-unknown-parameters -- the I/O boundary itself: turning an unparsed input into `I` is what these three exist to do, and `Api<R>` types every call site above them */
const validate = <I>(
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
  // SAFETY: Standard Schema guarantees `value` is the schema's output once `issues` is absent, and `I` is that output — `local.query`/`local.mutation` tie the two together with `Output<S>`
  const parsed = outcome.value as I;
  return Result.ok(parsed);
};

export const local = {
  query: {
    input: <S extends StandardSchemaV1>(schema: S) => ({
      handler: <T>(run: QueryDef<Output<S>, T>["run"]): QueryDef<Output<S>, T> => ({
        kind: "query",
        schema,
        run,
      }),
    }),
    handler: <T>(run: QueryDef<void, T>["run"]): QueryDef<void, T> => ({ kind: "query", run }),
  },
  mutation: {
    input: <S extends StandardSchemaV1>(schema: S) => ({
      handler: <T>(run: MutationDef<Output<S>, T>["run"]): MutationDef<Output<S>, T> => ({
        kind: "mutation",
        schema,
        run,
      }),
    }),
    handler: <T>(run: MutationDef<void, T>["run"]): MutationDef<void, T> => ({
      kind: "mutation",
      run,
    }),
  },
};

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

/** What a built leaf hands back: an inert read, or a write already running. */
type ApiLeaf = (
  given: never,
) => QueryCall<unknown> | Promise<ResultType<WriteResult<unknown>, CallError>>;

/** One node of the built surface: a callable leaf, or a group of them. */
type ApiNode = ApiLeaf | { readonly [key: string]: ApiNode };

/** The shape `meshApi` builds: a query becomes a descriptor, a mutation a `Result`-returning call. */
export type Api<R extends Router> = {
  /** `useCan(api.$can, "book.insert")` — the `$` marks framework surface, as `$sync` does on a row. */
  readonly $can: Permissions;
} & {
  readonly [K in keyof R]: R[K] extends QueryDef<infer I, infer T>
    ? (input: I) => QueryCall<T>
    : R[K] extends MutationDef<infer I, infer T>
      ? (input: I) => Promise<ResultType<WriteResult<T>, CallError>>
      : R[K] extends Router
        ? Api<R[K]>
        : never;
};

const isDef = (node: ProcedureDef | Router): node is ProcedureDef =>
  "kind" in node && (node.kind === "query" || node.kind === "mutation");

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
export function meshApi<R extends Router>(
  mesh: Mesh,
  router: R,
  options: { readonly instance?: string } = {},
): Api<R> {
  const handle = (): Handle => mesh.on(options.instance).unwrap();

  /* thrown, not returned: a descriptor has no error channel of its own, and the hook has an `error` */
  const runnable = (def: QueryDef<never, unknown>, input: unknown) =>
    def.run({ input: validate<never>(def.schema, input).unwrap(), mesh: handle() });

  const query = (path: string, def: QueryDef<never, unknown>, input: unknown) => ({
    kind: "query" as const,
    path,
    key: JSON.stringify([path, input ?? null]),
    run: () => runnable(def, input),
    live: () => handle().live(runnable(def, input)),
    settled: () => mesh.settled(),
  });

  const mutation = async (def: MutationDef<never, unknown>, input: unknown) => {
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

  const build = (node: Router, prefix: string): ApiNode => {
    const out: { [key: string]: ApiNode } = {};
    for (const [name, child] of Object.entries(node)) {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      if (!isDef(child)) {
        out[name] = build(child, path);
      } else if (child.kind === "query") {
        out[name] = (given: never) => query(path, child, given);
      } else {
        out[name] = (given: never) => mutation(child, given);
      }
    }
    return out;
  };

  const permissions: Permissions = {
    can: (what, row) => mesh.can(what, row, options.instance),
    grants: { onRegistered: (listener) => mesh.grants.onRegistered(() => listener()) },
  };
  // SAFETY: `build` walks the same router the `Api<R>` mapped type describes, leaf for leaf
  const walked = { ...build(router, ""), $can: permissions } as Api<R>;
  return walked;
}
/* oxlint-enable anti-slop/no-unknown-parameters */

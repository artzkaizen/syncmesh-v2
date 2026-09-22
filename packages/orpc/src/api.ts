import type { Handle, Mesh, MeshSchema, ReadCoverage, ReadCoverageView } from "@syncmesh/client";
import type { Live, Runnable } from "@syncmesh/drizzle";
import type { Principal } from "@syncmesh/engine";
import type { EventId, PeerId } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { PresenceMap } from "@syncmesh/schema";
import type { TxReceipt } from "@syncmesh/storage";

import { LOCAL_ONLY } from "@syncmesh/client";
import { readOnly, scopeReads } from "@syncmesh/drizzle";
import { Result } from "@syncmesh/result";

import type { LazyApiMesh } from "./deferred.js";
import type { AuthorityDef, AuthorityLink, MutationDef, QueryDef, Router } from "./procedures.js";
import type { Write, WriteDeps, WriteLedger } from "./write.js";

import { deferredLive, deferredRunnable, deferredSubscribe, lazyOf, notOpen } from "./deferred.js";
import { AuthorityUnreachable, NothingWritten } from "./errors.js";
import { isDef } from "./procedures.js";
import { scopeKinds, scopeOf } from "./scope.js";
import { validate } from "./validate.js";
import { createWrite } from "./write.js";

export type {
  AuthorityContext,
  AuthorityDef,
  AuthorityHandlers,
  AuthorityLink,
  DeclaredErrors,
  MutationContext,
  MutationDef,
  ProcedureDef,
  QueryContext,
  QueryDef,
  RouteMeta,
  Router,
} from "./procedures.js";
export { isDef, mutation, query } from "./procedures.js";
export { validate } from "./validate.js";

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

/**
 * Anything a call can fail with; a procedure's own declared errors ride the same channel.
 *
 * Still `Error` at the top, and deliberately: a handler may throw a class this package has never
 * heard of, and narrowing the channel would be a lie about what can arrive. What changed is that
 * everything **this layer** mints now carries a `_tag` — {@link InputInvalid},
 * {@link NothingWritten}, {@link AuthorityUnreachable}, {@link NoBodyBound},
 * {@link SchemaNotSynchronous} — so the failures a caller actually branches on are matchable
 * rather than prose. Over HTTP they cross as `{ _tag, message, ...fields }` and revive into the
 * class the caller declared (`wireError` in `http.ts`).
 */
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
  /**
   * How far the world has answered this read, with the source and checkpoint it is good to
   * (book ch. 9). `local-only` before the mesh opens and until a source completes its first pass.
   */
  readonly coverage: () => ReadCoverage;
  readonly onCoverage: (listener: () => void) => () => void;
}

/* oxlint-disable anti-slop/no-unknown-parameters -- every `input` below is the call's own argument on its way to `validate`, which is the parser. The surface above them (`Api<R>`) is typed per procedure, so a caller cannot reach these with anything else; taking a named type here would mean parsing before the procedure that owns the schema has been chosen. */

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

/**
 * The rehearsal of one write (book ch. 15): inert like a read, because a screen builds it while
 * deciding whether to draw the affordance at all. Running it executes the handler against the
 * replica, judges the staged changes by the same rules every receiver runs, and rolls the
 * transaction back — so it cannot drift from enforcement the way a second copy of the rules in
 * UI code does, and a refusal carries the rule's own reason.
 */
export interface CanCall {
  readonly kind: "can";
  /** `"products.create"` — what a devtool shows, and half the identity. */
  readonly path: string;
  /** Path and input: the same question asked twice is the same rehearsal. */
  readonly key: string;
  /** `Ok` means it would have been allowed; the `Err` is the refusal, reason and all. */
  readonly run: () => Promise<ResultType<void, CallError>>;
  /** A grant landing can change the answer, so whatever gated a button re-asks. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** What a built leaf hands back: an inert read, or a write already running. */
type ApiLeaf = (
  given: never,
) => QueryCall<unknown> | Write<unknown> | Promise<ResultType<unknown, CallError>>;

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
      ? ((input: I) => Write<T>) & {
          /** The same write, rehearsed against the replica and rolled back (ch. 15). */
          readonly can: (input: I) => CanCall;
        }
      : R[K] extends AuthorityDef<infer I, infer T>
        ? (input: I) => Promise<ResultType<T, CallError>>
        : R[K] extends Router
          ? Api<R[K]>
          : never;
};

/**
 * Every member of a mesh this binding reads, and no more.
 *
 * Stated rather than taking `Mesh` whole because a tab that is not the origin's leader holds a
 * mesh on another thread and can honestly answer exactly these — so the same `meshApi` builds the
 * same api there, over a port, instead of a second implementation drifting beside this one. A
 * real `Mesh` satisfies it by having more.
 */
export interface ApiMesh<PC extends PresenceMap = Record<string, never>> {
  readonly on: Mesh<"sqlite", PC>["on"];
  /** The manifest, for the one thing this binding reads off it: which kinds a call can scope to. */
  readonly schema: MeshSchema;
  readonly settled: () => Promise<void>;
  /**
   * Optional, because a mesh reached over a port (`adapters/browser`) forwards what it can ask
   * for, and until it forwards this a read there honestly answers `local-only` — the word for
   * "nothing here can say more" — rather than failing to build at all.
   */
  readonly coverage?: ReadCoverageView;
  readonly can: Mesh<"sqlite", PC>["can"];
  /** Only the subscription: a grant landing is what makes a gated affordance re-ask. */
  readonly grants: { readonly onRegistered: (listener: () => void) => () => void };
  /** Who this device acts as; a handler is handed it rather than asking, because it never picks. */
  readonly auth: { readonly principal: () => Principal | undefined };
  /**
   * This device's author id, for the columns correlated on it (`syncOf`).
   *
   * A value rather than a reader because it never changes while a process runs, and because a
   * window has to *await* it — the port cannot answer synchronously and a query that selected
   * `syncOf` before the answer landed would be correlated on nothing.
   */
  readonly self: PeerId;
  /** The write ledger, the engine's own or a window's reader of the origin's ({@link WriteLedger}). */
  readonly operations?: WriteLedger;
}

/**
 * Binds a router to one mesh: `api.books.list(…)`, `api.books.create(…)`.
 *
 * **It binds no scope, and that is the contract** (book ch. 3). A client knows no tenant,
 * workspace or shop; every call says which replica it is about by carrying the scope in its own
 * input, and {@link scopeOf} reads it back out. The shape this replaced — one api bound to one
 * instance at construction — is rejected by name in the book, for the reason that outlives any
 * particular app: a scope id is ordinary data, and data changes without reconstruction. An app
 * that bound it had to rebuild the api to change shop, and two shops meant two of everything.
 *
 * @example
 * const mesh = (await createMesh({ … })).unwrap();
 * export const api = meshApi(mesh, { books });
 * api.books.list({ shopId });   // the scope rides here, and nowhere else
 */
export function meshApi<R extends Router, PC extends PresenceMap = Record<string, never>>(
  source: ApiMesh<PC> | LazyApiMesh<PC>,
  router: R,
  options: {
    /**
     * Carries the calls this device cannot run. Absent, an `authority` call fails as itself
     * rather than pretending — which is the honest answer on a device with no network
     * configured, and a great deal better than a call that silently does nothing.
     */
    readonly link?: AuthorityLink;
  } = {},
): Api<R> {
  const lazy = lazyOf(source);
  /** The mesh, which a call inside a write or after `$ready` always has; a call before it does not. */
  const mesh = (): ApiMesh<PC> => lazy.current() ?? notOpen();
  const kinds = scopeKinds(lazy.schema);
  /** The replica this call is about — opened per call, because the scope arrives per call. */
  const handle = (input: unknown): Handle => mesh().on(scopeOf(kinds, input)).unwrap();

  /**
   * What a body is handed: its input, the tables, and who is acting.
   *
   * `db` is taken from `writing` where there is one, so a handler inside a write or a rehearsal
   * reads and writes through the span's own sink rather than the handle's — the difference
   * between landing inside the open transaction and waiting for it. The handler never sees which.
   */
  const context = <I>(input: I, open: Handle, writing?: { readonly db: Handle["db"] }) => ({
    input,
    db: scopeReads(writing?.db ?? open.db, open.read),
    principal: mesh().auth.principal(),
    self: mesh().self,
  });

  /**
   * The same context with the write verbs taken off, for a `query` body (§2.4).
   *
   * Subtraction rather than a second object, so the two cannot drift: a query handler reads
   * through exactly the `db` a mutation handler reads through, and the only difference is what
   * is missing from it.
   */
  const reading = <I>(input: I, open: Handle) => {
    const writable = context(input, open);
    return { ...writable, db: readOnly(writable.db) };
  };

  /* thrown, not returned: a descriptor has no error channel of its own, and the hook has an `error` */
  const runnable = (def: QueryDef<never, unknown>, input: unknown) =>
    ((open) => def.run(reading(validate<never>(def.schema, input).unwrap(), open)))(handle(input));

  const read = (path: string, def: QueryDef<never, unknown>, input: unknown) => ({
    kind: "query" as const,
    path,
    key: JSON.stringify([path, input ?? null]),
    // the real builder the moment there is one: `windowOf` reads a Drizzle query's own config to
    // decide whether the query can be maintained, and a stand-in has none to read. Only a call
    // made before the mesh exists gets the wrapper, and that one has nothing to maintain from
    run: () =>
      lazy.current() === undefined
        ? deferredRunnable(lazy.ready, () => runnable(def, input))
        : runnable(def, input),
    // TEMPORARY, for a bisect: one built query rather than the *way to build* it, which is what
    // turns incremental maintenance off — `createLive` only patches a query it can ask again.
    // Restore the factory (`() => runnable(def, input)`) once the assignee stall is attributed.
    live: () => deferredLive(lazy, () => handle(input).live(runnable(def, input))),
    settled: () => lazy.ready.then(() => mesh().settled()),
    // one shared object, never a literal: a mesh reached over a port has no coverage yet, and a
    // fresh `{ kind }` per call here is exactly the snapshot loop React refuses
    coverage: () => lazy.current()?.coverage?.get() ?? LOCAL_ONLY,
    onCoverage: (listener: () => void) =>
      deferredSubscribe(lazy, (m) => m.coverage?.subscribe(listener) ?? (() => undefined)),
  });

  /** `api.products.create.can(input)`: the write, rehearsed and rolled back (ch. 15). */
  const rehearsal = (path: string, def: MutationDef<never, unknown>, input: unknown): CanCall => ({
    kind: "can",
    path,
    key: JSON.stringify([path, input ?? null]),
    run: async () => {
      const parsed = validate<never>(def.schema, input);
      if (parsed.isErr()) return parsed;
      await lazy.ready;
      const open = handle(input);
      return open.rehearse(async (span) => {
        // the handler's return value is nothing to a rehearsal: only what it staged is judged —
        // and it writes through the span, because the rehearsal's transaction is the span's alone
        await def.run(context(parsed.value, open, span));
      });
    },
    subscribe: (listener) =>
      deferredSubscribe(lazy, (m) => m.grants.onRegistered(() => listener())),
  });

  /**
   * A write, as the statement it is (book ch. 10): the id is allocated here so the handle can
   * hand it back synchronously, and the commit runs under it.
   */
  const statement = (
    path: string,
    def: MutationDef<never, unknown>,
    input: unknown,
  ): Write<unknown> => {
    const id = crypto.randomUUID();
    // the commit waits for the mesh; the ledger is read when the record is, which is after it
    const deps: WriteDeps = {
      id,
      committed: lazy.ready.then(() => write(path, def, input, id)),
      get ledger() {
        return lazy.current()?.operations;
      },
    };
    return createWrite(deps);
  };

  const write = async (
    path: string,
    def: MutationDef<never, unknown>,
    input: unknown,
    operationId?: string,
  ) => {
    const parsed = validate<never>(def.schema, input);
    if (parsed.isErr()) return parsed;
    const open = handle(input);
    let receipt: TxReceipt | undefined;
    const off = open.onCommit((r) => {
      receipt = r;
    });
    // one transaction, so a handler that writes twice is still one event — and one *scope*, so
    // the read a live query fires while the handler is mid-transaction waits for it rather than
    // joining it and answering out of rows nothing has committed
    const run = () => {
      const span = open.span();
      return span.db.transaction(() => Promise.resolve(def.run(context(parsed.value, open, span))));
    };
    const ran = await Result.tryPromise({
      // recorded under the id the caller already holds, so an interrupted write is findable — and
      // under this procedure's own path, because the capture below sees SQL and cannot know it.
      // Without the name the ledger reads `issue.update` for what a person called `issues.move`.
      try: () => open.under({ id: operationId, label: path }, run),
      catch: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    off();
    if (ran.isErr()) return ran;
    if (receipt === undefined)
      return Result.err(
        new NothingWritten({
          path,
          message: `${path} staged no change, so there is no event to report`,
        }),
      );
    return Result.ok({ eventId: receipt.eventId, data: ran.value });
  };

  const remote = async (path: string, def: AuthorityDef<never, unknown>, input: unknown) => {
    const parsed = validate<never>(def.schema, input);
    if (parsed.isErr()) return parsed;
    if (options.link === undefined)
      return Result.err(
        new AuthorityUnreachable({
          path,
          message: `${path} runs on the authority, and no link was configured`,
        }),
      );
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
        // the rehearsal rides on the call itself: `api.products.create.can(input)`
        out[name] = Object.assign((given: never) => statement(path, child, given), {
          can: (given: never) => rehearsal(path, child, given),
        });
      } else {
        out[name] = (given: never) => remote(path, child, given);
      }
    }
    return out;
  };

  const permissions: Permissions = {
    // the row is the input here, and a row carries its scope in the same column the table is
    // partitioned by — "keyed by the scope already present in input and rows" (ch. 3)
    // before the mesh, nobody may do anything — which is what a gated button must draw anyway
    can: (what, row) => lazy.current()?.can(what, row, scopeOf(kinds, row)) ?? false,
    grants: {
      onRegistered: (listener) =>
        deferredSubscribe(lazy, (m) => m.grants.onRegistered(() => listener())),
    },
  };
  // SAFETY: `build` walks the same router the `Api<R>` mapped type describes, leaf for leaf
  const walked = { ...build(router, ""), $can: permissions } as Api<R>;
  return walked;
}
/* oxlint-enable anti-slop/no-unknown-parameters */

import type { Handle } from "@syncmesh/client";
import type { ReadOnlyDb, Runnable } from "@syncmesh/drizzle";
import type { Principal } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { Output, StandardSchemaV1 } from "@syncmesh/schema";

import type { CallError } from "./api.js";

/**
 * The grammar (book ch. 7): kind first, then the terminal. `query` and `mutation` say what a
 * procedure **is**; `.handler(fn)` says the body is right here and runs where your replica is,
 * and `.output(schema).authority()` says there is no body here — the authority decides, and the
 * shared chain is the contract for its answer. The terminal sits exactly where a reader looks
 * for the code, so a bodiless chain answers "where is the body?" in the same breath.
 */

/**
 * What a handler is handed: the parsed input, the tables, and who is calling.
 *
 * **Three things, not a mesh.** The shape this replaced passed the whole `Handle`, and a handler
 * reaching for `mesh.under` or `mesh.rehearse` was reaching past the transaction the binding had
 * already opened for it — a second write path inside the one that was running. What a body needs
 * is what it reads and writes through and the identity it is acting as; everything else on a
 * handle is the framework's business.
 *
 * `db` is the right one for the path it is on without the handler knowing which: the handle's own
 * for a query, and the span's inside a write or a rehearsal, so one body serves all three.
 */
interface BaseContext<I> {
  readonly input: I;
  /** Who this device is acting as; `undefined` before the first session (ch. 14). */
  readonly principal: Principal | undefined;
  /**
   * This device's own author id, for the columns that are correlated on it — `syncOf(self, table)`
   * asks *where did my write get to*, and "my" is this.
   */
  readonly self: PeerId;
}

/**
 * What a `mutation` body gets: the app's tables through the capture, so an `insert` here becomes
 * one signed event (ch. 10).
 *
 * `db` is the right one for the path it is on without the handler knowing which — the handle's
 * own, or the span's inside a write or a rehearsal — and every table it *selects* from is
 * already scoped to what this caller may read, on both dialects.
 */
export interface MutationContext<I> extends BaseContext<I> {
  readonly db: Handle["db"];
}

/**
 * What a `query` body gets: the same `db`, minus every verb that writes.
 *
 * There is no `read` beside it and no unscoped `db` behind it. One noun: `db.select().from(issue)`
 * returns the rows this caller may read, because the source is substituted for the table **as
 * they may read it** before the statement is built. The pair this replaced — a `db` that saw
 * everything and a `read()` the handler had to remember to wrap each table in — was only ever
 * safe on Postgres with `rls: true`, and silently returned the whole replica on every device.
 */
export interface QueryContext<I> extends BaseContext<I> {
  readonly db: ReadOnlyDb<Handle["db"]>;
}

/** The writing shape, under the name it had when both kinds shared one context. */
export type HandlerContext<I> = MutationContext<I>;

export interface QueryDef<I, T> {
  readonly kind: "query";
  readonly schema?: StandardSchemaV1;
  readonly route?: RouteMeta;
  readonly run: (args: QueryContext<I>) => Runnable<T>;
}

export interface MutationDef<I, T> {
  readonly kind: "mutation";
  readonly schema?: StandardSchemaV1;
  readonly route?: RouteMeta;
  readonly run: (args: MutationContext<I>) => Promise<T> | T;
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
  /** The server's tables, acting as the caller where the server binds one. */
  readonly db: Handle["db"];
  /** A table as this caller may read it, on the server's own replica. */
  readonly read: Handle["read"];
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
 * A read that runs **on this device**, against local SQLite, with no network in it. Unmarked
 * because it is the ordinary case (D26); what carries a qualifier is the `.authority()`
 * terminal — the call that needs a server and therefore fails on a ward with no signal —
 * because that is the one a reader has to notice.
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

/** A leaf, as opposed to a group: the three kinds the grammar can end in. */
export const isDef = (node: ProcedureDef | Router): node is ProcedureDef =>
  "kind" in node &&
  (node.kind === "query" || node.kind === "mutation" || node.kind === "authority");

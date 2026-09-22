export type { CallBody, HandlerOptions, HttpLinkOptions } from "./http.js";
export { createHandler, findProcedure, httpLink } from "./http.js";
export type { Client } from "./client.js";
export { createClient } from "./client.js";
export type { ClientOptions, PostgresStorage, SqliteStorage, Storage, Trust } from "./options.js";
export { postgres, sqlite } from "./options.js";
export type {
  Api,
  ApiMesh,
  AuthorityContext,
  AuthorityDef,
  AuthorityHandlers,
  AuthorityLink,
  CallError,
  CanCall,
  DeclaredErrors,
  MutationDef,
  Permissions,
  ProcedureDef,
  QueryCall,
  QueryDef,
  RouteMeta,
  Router,
  SyncSource,
  WriteResult,
} from "./api.js";
// `meshApi` is deliberately absent: it builds a client out of a mesh, which is `createClient`'s
// job and `connectMesh`'s, not an app's. It lives at `@syncmesh/orpc/internal` for those two.
export { mutation, query } from "./api.js";
export {
  AuthorityUnreachable,
  InputInvalid,
  NoBodyBound,
  NothingWritten,
  SchemaNotSynchronous,
} from "./errors.js";
export { watch } from "./watch.js";
export type { Write, WriteLedger } from "./write.js";
export { createWrite } from "./write.js";
export type { Server, ServerOptions } from "./server.js";
export { createServer } from "./server.js";

import type { Handle, Mesh } from "@syncmesh/client";
import type { JsonValue } from "@syncmesh/kernel";
import type { SqlDialect } from "@syncmesh/storage";

import { os } from "@orpc/server";
import { PolicyDenied } from "@syncmesh/engine";

/**
 * Who is calling, as your auth established it. The caller reached the server over HTTP with a
 * session, not a device key, so the mesh cannot know this — it is the initial context every
 * procedure built on `withMesh` requires, and the principal the schema's rules are evaluated for.
 */
export interface Caller {
  readonly account: string;
  readonly role?: string;
  /** Facts your auth vouches for, read by `claimHas`-style rules. */
  readonly claims?: Readonly<Record<string, JsonValue>>;
  /** The instance this call runs under — `"org:acme"`. */
  readonly partition: string;
}

export interface CallerContext {
  readonly caller: Caller;
}

/** What `withMesh` adds: the Drizzle surface, pinned to the caller's instance and acting as the caller. */
export interface MeshContext<D extends SqlDialect = "sqlite"> {
  readonly mesh: Handle<D>;
}

/**
 * The base every procedure on an authority extends: the caller in, `mesh` out — `db`, `read` and
 * `live`, pinned to the caller's instance and **acting as the caller**, so the schema is the only
 * permission model. A row the caller may not read is absent from `read()` sources; a write their
 * rules deny rejects the transaction, which `.use(denials)` turns into `FORBIDDEN`.
 *
 * ```ts
 * const base = withMesh(server)
 * export const jobs = {
 *   assign: base
 *     .input(z.object({ id: z.string().uuid(), tech: z.string() }))
 *     .errors({ NOT_FOUND: {} })
 *     .handler(async ({ input, context: { mesh }, errors }) => {
 *       const j = read(jobs)
 *       const [job] = await db.select().from(j).where(eq(j.id, input.id))
 *       if (job === undefined) throw errors.NOT_FOUND()
 *       await db.update(jobs).set({ assignee: input.tech }).where(eq(jobs.id, input.id))
 *     }),
 * }
 * ```
 */
/**
 * A refusal the caller's own rules made, found under Drizzle's wrapper.
 *
 * The capture throws `PolicyDenied` as itself; Drizzle catches it inside `transaction()` and
 * re-throws a `DrizzleQueryError` carrying the original as `cause`. So the unwrap is **one step
 * and one known shape** — not the walk-any-chain-and-match-a-tag-by-string helper this replaced,
 * which would have found a `PolicyDenied` nested at any depth, put there for any reason, and
 * turned somebody else's failure into this caller's `FORBIDDEN`.
 */
const refusal = (cause: unknown): PolicyDenied | undefined => {
  if (cause instanceof PolicyDenied) return cause;
  const under = cause instanceof Error ? cause.cause : undefined;
  return under instanceof PolicyDenied ? under : undefined;
};

export function withMesh<D extends SqlDialect = "sqlite">(mesh: Mesh<D>) {
  return os
    .$context<CallerContext>()
    .errors({
      BAD_REQUEST: { message: "the call names an instance the manifest cannot resolve" },
      FORBIDDEN: { message: "the schema's rules deny this to the caller" },
    })
    .use(async ({ context, next, errors }) => {
      const { caller } = context;
      const as = { account: caller.account, claims: caller.claims ?? {} };
      if (caller.role !== undefined) Object.assign(as, { role: caller.role });
      const handle = mesh.on(caller.partition, { as });
      if (handle.isErr()) throw errors.BAD_REQUEST({ message: handle.error.message });
      try {
        return await next({ context: { mesh: handle.value } satisfies MeshContext<D> });
      } catch (cause) {
        throw refusal(cause) === undefined ? cause : errors.FORBIDDEN();
      }
    });
}

export type { Custody, Serving } from "./custody.js";

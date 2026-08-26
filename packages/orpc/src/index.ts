import type { Mesh, Pins, Scoped } from "@syncmesh/client";
import type { JsonValue } from "@syncmesh/kernel";
import type { ColumnsMap } from "@syncmesh/schema";

import { os } from "@orpc/server";

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
  /** The instances this call runs under — `{ org: "acme" }` — resolved by `mesh.scoped`. */
  readonly pins: Pins;
}

export interface CallerContext {
  readonly caller: Caller;
}

/**
 * What `withMesh` adds: the mesh, pinned to the caller's instances and acting as the caller.
 * Not an ORM — the same collection verbs a device has (`get` / `list` / `create` / `update` /
 * `delete` / `tx` / `history`), under the schema's rules. Queries that need SQL — joins,
 * aggregates — run against the tables the server's state store materialises (E17), which is
 * your Drizzle instance, not this.
 */
export interface MeshContext<C extends ColumnsMap> {
  readonly mesh: Scoped<C>;
}

/**
 * The base every procedure on an authority extends: the caller in, `mesh` out — the mesh scoped
 * to the caller's instances and **acting as the caller**, so the schema is the only permission
 * model. `mesh.jobs.list()` holds only rows the caller's `read` rule admits; a write the caller's
 * rule denies is `Err(PolicyDenied)` before any event. A pin the manifest cannot resolve is
 * `BAD_REQUEST` before any handler; `FORBIDDEN` is there for handlers to answer a denial with.
 *
 * ```ts
 * const base = withMesh(server)
 * export const jobs = {
 *   assign: base
 *     .input(z.object({ id: z.string().uuid(), tech: z.string() }))
 *     .errors({ NOT_FOUND: {}, CONFLICT: {} })
 *     .handler(async ({ input, context: { mesh }, errors }) => {
 *       if (mesh.jobs.get(input.id) === undefined) throw errors.NOT_FOUND()   // unreadable reads as absent
 *       const written = await mesh.tx((c) => …, { label: "jobs.assign" })
 *       if (written.isErr())
 *         throw written.error._tag === "PolicyDenied" ? errors.FORBIDDEN() : written.error
 *       return { eventId: written.value.eventId }
 *     }),
 * }
 * ```
 */
export function withMesh<C extends ColumnsMap>(mesh: Mesh<C>) {
  return os
    .$context<CallerContext>()
    .errors({
      BAD_REQUEST: { message: "the call names an instance the manifest cannot resolve" },
      FORBIDDEN: { message: "the schema's rules deny this to the caller" },
    })
    .use(({ context, next, errors }) => {
      const { caller } = context;
      const scoped = mesh.scoped(caller.pins, { as: caller });
      if (scoped.isErr()) throw errors.BAD_REQUEST({ message: scoped.error.message });
      return next({ context: { mesh: scoped.value } satisfies MeshContext<C> });
    });
}

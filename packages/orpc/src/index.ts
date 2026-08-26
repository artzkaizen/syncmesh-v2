import type { Mesh, Pins, Scoped } from "@syncmesh/client";
import type { ColumnsMap } from "@syncmesh/schema";

import { os } from "@orpc/server";
import { roleAtLeast } from "@syncmesh/policy";

/**
 * Who is calling, as your auth established it: the account, its role in the instances the call
 * concerns, and those instances. A procedure never learns this from the mesh — the caller reached
 * the server over HTTP with a session, not a device key — so it is the initial context every
 * procedure built on `withMesh` requires.
 */
export interface Caller {
  readonly account: string;
  readonly role?: string;
  /** The instances this call runs under — `{ org: "acme" }` — resolved by `mesh.scoped`. */
  readonly pins: Pins;
}

export interface CallerContext {
  readonly caller: Caller;
}

/** What `withMesh` adds: the mesh, pinned to the caller's instances. */
export interface MeshContext<C extends ColumnsMap> {
  readonly db: Scoped<C>;
}

/** The role ladders of a manifest, read structurally so any `Schema<P, R, C>` fits. */
export interface RoleLadders {
  readonly rolesFor: (kind: never) => readonly string[];
}

/**
 * The base every procedure on an authority extends: the caller in, the mesh scoped to the
 * caller's instances out. A pin the manifest cannot resolve is `BAD_REQUEST`, before any handler.
 *
 * ```ts
 * const base = withMesh(server)
 * export const jobs = {
 *   assign: base
 *     .use(requireRole(schema, "org", "dispatcher"))
 *     .input(z.object({ id: z.string().uuid(), tech: z.string() }))
 *     .errors({ NOT_FOUND: {}, CONFLICT: {} })
 *     .handler(async ({ input, context: { db, caller }, errors }) => {
 *       if (db.jobs.get(input.id) === undefined) throw errors.NOT_FOUND()   // no event
 *       const { eventId } = (await db.tx((c) => …, { label: "jobs.assign" })).unwrap()
 *       return { eventId }
 *     }),
 * }
 * ```
 */
export function withMesh<C extends ColumnsMap>(mesh: Mesh<C>) {
  return os
    .$context<CallerContext>()
    .errors({ BAD_REQUEST: { message: "the call names an instance the manifest cannot resolve" } })
    .use(({ context, next, errors }) => {
      const db = mesh.scoped(context.caller.pins);
      if (db.isErr()) throw errors.BAD_REQUEST({ message: db.error.message });
      return next({ context: { db: db.value } satisfies MeshContext<C> });
    });
}

/**
 * `FORBIDDEN` unless the caller's role is `wanted` or more senior on the kind's ladder — the same
 * comparison `role("dispatcher")` makes in a table rule, so a procedure and the schema agree on
 * what "dispatcher or above" means.
 */
export function requireRole(ladders: RoleLadders, kind: string, wanted: string) {
  // SAFETY: rolesFor is typed by the manifest's own kinds; an unknown kind yields an empty ladder, which admits nobody
  const ladder = ladders.rolesFor(kind as never);
  return os
    .$context<CallerContext>()
    .errors({ FORBIDDEN: { message: `needs ${wanted} or above in ${kind}` } })
    .middleware(({ context, next, errors }) => {
      if (!roleAtLeast(ladder, context.caller.role, wanted)) throw errors.FORBIDDEN();
      return next();
    });
}

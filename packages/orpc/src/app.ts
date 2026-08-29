import type { Mesh, MeshOptions } from "@syncmesh/client";
import type { ColumnsMap, PartitionTree, PresenceMap, Roles } from "@syncmesh/schema";

import { createMesh } from "@syncmesh/client";
import { panic } from "@syncmesh/result";

import type { Api, AuthorityLink, Router } from "./api.js";

import { meshApi } from "./api.js";

/**
 * Everything an app constructs, in one call.
 *
 * `createMesh` then `meshApi` is two steps for one idea, and an app that writes both ends up with
 * a `Mesh` in a variable it never uses again and a wrapper function whose only job is to pass it
 * along. There is one mesh and one api; they are made together.
 *
 * **Throws rather than returning a `Result`,** which is the opposite of `createMesh` underneath
 * it and deliberate. A `Result` earns its place where the caller can do something else and carry
 * on, and at boot there is nothing else: `StoreFailure` means the database will not open, and
 * `StateCorrupt` reaches here only when the log is compacted below the damage — its own message
 * says *rejoin from a peer*, which is a different construction, not something to do with this
 * handle. Every call site that had the `Result` unwrapped it or rethrew.
 *
 * `createMesh` keeps returning one, because it is the seam a library embeds: opening one mesh per
 * tenant (D07) must be able to fail for one without killing the rest.
 *
 * @example
 * export const { api } = await createApp({
 *   schema,
 *   procedures: { patients, observations },
 *   instance: "practice:st-mary",
 *   identity: await loadIdentity(),
 *   driver: sqlite("rounds.db"),
 *   transports: [relayTransport({ dial: webSocketDial(RELAY_URL) })],
 * });
 */
export interface AppOptions<
  R extends Router,
  P extends PartitionTree,
  RS extends Roles<P>,
  C extends ColumnsMap,
  PC extends PresenceMap,
> extends MeshOptions<P, RS, C, "sqlite", PC> {
  /** The app's own API — every read and write it performs. */
  readonly procedures: R;
  /** The tenant this app instance runs under; omitted for a schema with only built-in kinds. */
  readonly instance?: string;
  /** Carries `authority` calls. Absent, one fails naming itself rather than pretending. */
  readonly link?: AuthorityLink;
}

export interface App<R extends Router, PC extends PresenceMap = Record<string, never>> {
  readonly api: Api<R>;
  /**
   * The mesh underneath. An app needs it to stop, and for the few facts that are not a procedure
   * — `ready`, `settled`, `requestGrant`. Everything it *reads or writes* is `api`.
   */
  readonly mesh: Mesh<"sqlite", PC>;
}

export async function createApp<
  R extends Router,
  P extends PartitionTree,
  const RS extends Roles<P>,
  C extends ColumnsMap,
  PC extends PresenceMap = Record<string, never>,
>(options: AppOptions<R, P, RS, C, PC>): Promise<App<R, PC>> {
  const { procedures, instance, link, ...meshOptions } = options;
  const opened = await createMesh(meshOptions);
  // the tagged error travels as the cause, so a caller who does want to branch — "storage
  // damaged, rejoin?" — still can, without every other caller unwrapping to reach it
  if (opened.isErr()) return panic(`the app could not open: ${opened.error.message}`, opened.error);

  // assigned rather than spread: `exactOptionalPropertyTypes` reads an explicit `undefined` as a
  // value, and "no instance" is the absence of the key
  const bound = {};
  if (instance !== undefined) Object.assign(bound, { instance });
  if (link !== undefined) Object.assign(bound, { link });
  const mesh = opened.value;
  return { api: meshApi(mesh, procedures, bound), mesh };
}

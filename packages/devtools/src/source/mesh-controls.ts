import type { Mesh } from "@syncmesh/client";
import type { TransportCondition } from "@syncmesh/transport";

import { createHub } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";

import type { DevtoolsControls } from "../controls.js";

import { ControlRefused } from "../controls.js";

/**
 * The operator half, over a live mesh — the surface a host passes in on purpose, or does not.
 *
 * Deliberately separate from `createMeshSource`. That one is what the panels *read*, and its
 * value is that it cannot write; this one is what a developer *does*, and an app that never calls
 * it ships an inspector with no path to `force` at all. Two factories rather than an option on
 * one, because an option is something a production build can forget to turn off and a call is
 * something a production build simply does not contain.
 *
 * It holds **no subscriptions**. `forced()` reads the mesh each time, because the mesh is where
 * the fact lives: an app that calls `mesh.transports.force` itself is still reported here, and a
 * mirror kept in this file would have been the copy that went stale. The hub exists only to tell
 * a badge to look again after a click.
 */

const refusalFrom = (
  transport: string,
  action: "force" | "release",
  cause: { readonly message: string },
): ControlRefused => new ControlRefused({ transport, action, message: cause.message, cause });

/**
 * The slice of `Mesh` this needs, which is three members of one of its sixteen surfaces.
 *
 * A `Pick` for the same reason `LinksSource` is one: it says in the type that nothing else on the
 * mesh is reachable from here, and it lets a test drive the operator half without booting an
 * engine, opening a database and waiting for a fold.
 */
export interface ControlsMesh {
  readonly transports: Pick<Mesh["transports"], "force" | "release" | "forced">;
}

export function createMeshControls(mesh: ControlsMesh): DevtoolsControls {
  const changed = createHub<void>();
  const act = async (
    name: string,
    action: "force" | "release",
    run: () => Promise<Result<void, { readonly message: string }>>,
  ) => {
    const outcome = await run();
    if (outcome.isErr()) return Result.err(refusalFrom(name, action, outcome.error));
    changed.emit();
    return Result.ok(undefined);
  };
  return {
    forced: () => mesh.transports.forced(),
    force: (name: string, as: TransportCondition) =>
      act(name, "force", () => mesh.transports.force(name, as)),
    release: (name: string) => act(name, "release", () => mesh.transports.release(name)),
    onChange: (listener) => changed.subscribe(() => listener()),
  };
}

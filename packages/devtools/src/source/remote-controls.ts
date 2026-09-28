/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-shape-in-symbol-names -- the window's end of the inspector port: an answer arrives as `unknown` and the action it answered is the parse */

import type { RemoteInspect } from "@syncmesh/browser";
import type { ForcedMedium } from "@syncmesh/client";
import type { Result as ResultType } from "@syncmesh/result";
import type { TransportCondition } from "@syncmesh/transport";

import { Result } from "@syncmesh/result";

import type { DevtoolsControls } from "../controls.js";

import { ControlRefused } from "../controls.js";
import { revive, uncarry } from "./inspect-wire.js";

/**
 * The operator half from a window that holds no engine — and **a control here is a device-wide act.**
 *
 * This is the one surprising thing about the inspector in a multi-tab app, so it is worth saying
 * plainly: holding `ble` in `radio-off` from the fourth tab switches it off **for the origin**.
 * There is one device here and one set of radios, not one per window; the mesh those tabs read
 * from is a single engine in a single thread, and the transport being held is that engine's. So
 * every other window's header badge lights up, every other window's Transports panel shows the
 * medium held, and `mesh.status.get()` reports the condition to an app that never imported any of
 * this. A toggle that only affected the tab it was clicked in would be a lie about a radio.
 *
 * The same rule as everywhere else survives the crossing: nothing is remembered, so a reload
 * anywhere releases nothing, and the *engine's* reload — the leader's tab closing and another
 * being promoted — starts a mesh with no held mediums, because the held set lived in the thread
 * that went.
 *
 * It costs one low-frequency subscription per window and no mesh subscription at all: the leader's
 * `createMeshControls` holds none by construction, so a header badge is affordable in a build that
 * never opens a panel.
 */

/** What a window needs to build one: the same inspector door the remote source reads through. */
export interface RemoteControlsMesh {
  readonly inspect: RemoteInspect;
}

const refusalFor =
  (transport: string, action: "force" | "release") =>
  (cause: unknown): ControlRefused =>
    new ControlRefused({
      transport,
      action,
      message: "the tab holding this mesh stopped answering, so the medium was not touched",
      cause,
    });

export function createRemoteControls(mesh: RemoteControlsMesh): DevtoolsControls {
  const { inspect } = mesh;
  const listeners = new Set<() => void>();
  let held: readonly ForcedMedium[] = [];

  const take = (answer: unknown): void => {
    // SAFETY: the host broadcasts what its own `controls.forced()` returned, which is this shape
    held = revive(answer) as readonly ForcedMedium[];
    for (const listener of listeners) listener();
  };

  // the push is also the prime: the host answers a fresh subscriber with nothing, so the first
  // reading is asked for, and every one after it arrives because somebody — in any window — clicked
  inspect.onForced(take);
  void inspect.read("forced").then(take, () => undefined);

  const act = async (
    name: string,
    action: "force" | "release",
    args: readonly unknown[],
  ): Promise<ResultType<void, ControlRefused>> => {
    const answer = await inspect
      .read(action, args)
      .catch((cause: unknown) => ({ ok: false as const, error: { _tag: "@lost", cause } }));
    const outcome = uncarry<void, ControlRefused>(answer, refusalFor(name, action));
    if (outcome.isErr()) return outcome;
    return Result.ok(undefined);
  };

  return {
    forced: () => held,
    force: (name: string, as: TransportCondition) => act(name, "force", [name, as]),
    release: (name: string) => act(name, "release", [name]),
    onChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

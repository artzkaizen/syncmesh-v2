/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- the payloads here are deliberately unread: this file carries an inspector's vocabulary across a port without learning a word of it, which is what keeps `@syncmesh/devtools` out of every tab's bundle */

import type { Unsubscribe } from "@syncmesh/engine";

import type { MeshWire } from "./wire.js";

/**
 * What a host must be handed before any tab of this origin can inspect the mesh.
 *
 * **The opt-in is the safety property**, the same way `DevtoolsControls` is an argument rather
 * than a flag: `serveMesh(mesh)` with no inspector serves an origin whose windows can read their
 * own data and nothing about the device, and every inspect ask is refused with `NoInspector`. A
 * production build gets there by passing one option fewer rather than by remembering to unset one.
 *
 * Nothing here is typed in terms of panels, snapshots or channels, and that is not laziness. The
 * inspector is `@syncmesh/devtools`' to build (`createInspectorHost`); if this file knew the names
 * it would have to import the package that declares them, and a dev-only inspector would be in
 * the bundle of every tab that ever opened the app. So the names are strings, the payloads are
 * `unknown`, and the one thing the adapter contributes is the port and the refcount.
 *
 * @example
 * // in the elected tab's dedicated worker
 * const host = serveMesh(app.mesh, { inspector: createInspectorHost(app.mesh) });
 */
export interface MeshInspector {
  /**
   * Answers one named read. The names are the inspector's own; a name it does not know is its own
   * to refuse, and the refusal crosses as a tagged error like any other.
   */
  readonly read: (name: string, args: readonly unknown[]) => Promise<unknown>;
  /**
   * The coalesced "these facts moved" feed, and the **acquisition** of whatever the reads need.
   *
   * Subscribing is what opens the origin's one inspector source, and letting go of the last
   * listener is what closes it — so the engine subscriptions a devtool costs exist exactly while
   * some tab has the panel open, and a tab that closes leaves none behind.
   */
  readonly watch: (listener: (moved: unknown) => void) => Unsubscribe;
  /**
   * Which mediums are being held by hand, after each change to that set.
   *
   * Separate from {@link MeshInspector.watch} because a header badge wants this fact without
   * paying for the reader: holding a medium is a person clicking, it moves a handful of times a
   * session, and the operator surface underneath it subscribes to nothing on the mesh.
   */
  readonly onForced: (listener: (held: unknown) => void) => Unsubscribe;
}

/**
 * A tab's end of the same door.
 *
 * `read` is a round trip; `watch` and `onForced` are the two server-initiated topics, refcounted
 * per tab by the wire exactly as `fold` is — so the last panel closing in this tab releases the
 * origin's inspector if no other tab is watching it.
 */
export interface RemoteInspect {
  readonly read: (name: string, args?: readonly unknown[]) => Promise<unknown>;
  readonly watch: (listener: (moved: unknown) => void) => Unsubscribe;
  readonly onForced: (listener: (held: unknown) => void) => Unsubscribe;
}

export function remoteInspect(wire: MeshWire): RemoteInspect {
  return {
    read: async (name, args = []) => {
      const answer = await wire.ask<{ readonly inspected: unknown }>({
        kind: "inspect",
        read: name,
        args,
      });
      return answer.inspected;
    },
    watch: (listener) => wire.listen("inspect", listener),
    onForced: (listener) => wire.listen("forced", listener),
  };
}

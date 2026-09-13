import type { FollowerMesh } from "@syncmesh/browser";
import type { DevtoolsControls } from "@syncmesh/devtools";

import { createRemoteControls } from "@syncmesh/devtools";

/**
 * The operator surface for this window, built once per mesh and shared by everything that draws it.
 *
 * One object rather than one per component, because the header's badge and the panel's toggles are
 * two views of a single fact and a second `createRemoteControls` would be a second cache of it —
 * and a second low-frequency subscription, held for the life of the tab, for nothing.
 *
 * A `WeakMap` rather than a module-level value because a handover replaces the mesh: the leader's
 * tab closes, this one reconnects over a new port, and the controls that were reading through the
 * old one have to go with it.
 *
 * **What is held is held for the device.** A radio switched off from this window is switched off
 * for the origin — there is one device and one set of mediums — so the badge lights up in every
 * other tab too. That is surprising exactly once, which is why it is written here and in
 * `createRemoteControls`' own doc comment rather than left to be discovered.
 */
const held = new WeakMap<FollowerMesh, DevtoolsControls>();

export const inspectorControls = (mesh: FollowerMesh): DevtoolsControls => {
  const found = held.get(mesh);
  if (found !== undefined) return found;
  const made = createRemoteControls(mesh);
  held.set(mesh, made);
  return made;
};

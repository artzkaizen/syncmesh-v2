import type { FollowerMesh } from "@syncmesh/browser";
import type { DevtoolsControls, DevtoolsSource } from "@syncmesh/devtools";

import { SyncmeshDevtools, createRemoteSource, defaultTabs } from "@syncmesh/devtools/react";
import { useCallback } from "react";

/**
 * The inspector, over the origin's one mesh, from whichever window you opened it in.
 *
 * `source` is a factory and it answers with a **promise**, and both facts are the architecture
 * showing through. Closed, this component is a button and a keydown listener: nothing is built, no
 * port topic is held, and the tab that holds the engine has not taken a single subscription on it.
 * Opening builds a window onto the leader's one `createMeshSource` — a round trip, hence the
 * promise — and closing gives it back, which on the leader's side releases the source itself if no
 * other window is watching.
 *
 * What is on screen is this origin's replica, not a second one opened for the occasion, and in a
 * follower that is the point: the Storage panel counts the leader's database, the Transports panel
 * names the device's real mediums, and the event above a row is the event the row came from.
 *
 * `controls` is passed here as well as to the header badge, and it is the **same object**, because
 * holding a radio is one act with one piece of state. See `inspectorControls`.
 */
/** Stable, because a new disposer every render is a source torn down and rebuilt every render. */
const release = (open: DevtoolsSource) => open.close();

export function Devtools({
  mesh,
  controls,
}: {
  readonly mesh: FollowerMesh;
  readonly controls: DevtoolsControls;
}) {
  const source = useCallback(() => createRemoteSource(mesh), [mesh]);
  return (
    <SyncmeshDevtools controls={controls} dispose={release} source={source} tabs={defaultTabs} />
  );
}

/**
 * The adapter from a running mesh to {@link DevtoolsSource} — one import, one call, one `close`.
 *
 * Separate from `../contract.js` because a panel depends on the contract and must not depend on
 * this: a panel built against the interface can be rendered over a fixture in a test, in a
 * screenshot harness, or over a source that reaches a mesh in another process, and none of those
 * should drag a subscription to a live engine into the bundle with them.
 */

export type { Channels, ChannelOptions } from "./channels.js";
export { createChannels } from "./channels.js";
export type { LinkRing } from "./link-ring.js";
export { LINK_HISTORY, createLinkRing } from "./link-ring.js";
export type { MediumWatch } from "./mediums.js";
export { watchMediums } from "./mediums.js";
export type { ControlsMesh } from "./mesh-controls.js";
export { createMeshControls } from "./mesh-controls.js";
export type { InspectServed, Opened, Snapshot, SnapshotName } from "./inspect-wire.js";
export { InspectRefused, SNAPSHOTS, inspectFailures } from "./inspect-wire.js";
export { createInspectorHost } from "./inspector-host.js";
export type { RemoteSourceMesh } from "./remote-source.js";
export { createRemoteSource } from "./remote-source.js";
export type { RemoteControlsMesh } from "./remote-controls.js";
export { createRemoteControls } from "./remote-controls.js";
export type { MeshSourceOptions } from "./mesh-source.js";
export { createMeshSource } from "./mesh-source.js";
export { refusalFor } from "./sql.js";
export type { StoreDialect, StoreReader } from "./store.js";
export { createStoreReader } from "./store.js";
export type { WritesReader } from "./writes.js";
export { createWritesReader } from "./writes.js";

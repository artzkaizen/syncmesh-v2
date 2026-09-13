/**
 * The parts of the inspector that are not React.
 *
 * A separate entry from `./react` so that a host can name a tab, read the tokens, or check what
 * the panel remembered without pulling a renderer into its graph — and so the component tree can
 * be replaced one day without the contract moving.
 */

export type {
  DevtoolsAck,
  DevtoolsAuthor,
  DevtoolsChannel,
  DevtoolsDispute,
  DevtoolsEndingTally,
  DevtoolsGrant,
  DevtoolsGrants,
  DevtoolsIdentity,
  DevtoolsLinkEvent,
  DevtoolsLinks,
  DevtoolsLogRows,
  DevtoolsMedium,
  DevtoolsOverview,
  DevtoolsParked,
  DevtoolsPeer,
  DevtoolsRoute,
  DevtoolsSchema,
  DevtoolsSource,
  DevtoolsSql,
  DevtoolsStore,
  DevtoolsSync,
  DevtoolsTable,
  DevtoolsWrite,
  DevtoolsWrites,
  SqlRow,
  SqlValue,
} from "./contract.js";
export { QueryFailed, QueryRefused } from "./contract.js";
export type { DevtoolsControls } from "./controls.js";
export { ControlRefused, FORCEABLE } from "./controls.js";
export type {
  ChannelOptions,
  Channels,
  ControlsMesh,
  InspectServed,
  LinkRing,
  MediumWatch,
  MeshSourceOptions,
  Opened,
  RemoteControlsMesh,
  RemoteSourceMesh,
  Snapshot,
  SnapshotName,
  StoreDialect,
  StoreReader,
  WritesReader,
} from "./source/index.js";
export {
  InspectRefused,
  LINK_HISTORY,
  SNAPSHOTS,
  createChannels,
  createInspectorHost,
  createLinkRing,
  createMeshControls,
  createMeshSource,
  createRemoteControls,
  createRemoteSource,
  createStoreReader,
  createWritesReader,
  inspectFailures,
  refusalFor,
  watchMediums,
} from "./source/index.js";

export { PREFIX, STYLESHEET } from "./css.js";
export type { FramePump, LongFrameEntry, LongFrameScript, LongFrameWatch } from "./dom.js";
export { framesOf, watchLongFrames } from "./dom.js";
export type { FrameBlame, FrameBucket, FrameReading, Frames as FrameSampler } from "./frames.js";
export { BUCKETS, BUCKET_MS, STALLED_MS, createFrames, droppedIn } from "./frames.js";
export type { DevtoolsStorage } from "./persist.js";
export {
  DEFAULT_STORAGE_KEY,
  PanelStateFailure,
  readPanelState,
  writePanelState,
} from "./persist.js";
export type { Corner, Dock, PanelState } from "./state.js";
export {
  CORNERS,
  clampSize,
  DEFAULT_PANEL_STATE,
  MAX_SIZE_RATIO,
  MIN_SIZE,
  sizeFromPointer,
} from "./state.js";
export type { DevtoolsTab, DevtoolsTabProps, TabRegistry } from "./tabs.js";
export { createTabRegistry, DuplicateTabId } from "./tabs.js";
export type { Severity } from "./tokens.js";
export {
  COLOR,
  FONT,
  RADIUS,
  SEVERITY_COLOR,
  SEVERITY_TINT,
  SPACE,
  TEXT,
  Z_LAYER,
} from "./tokens.js";

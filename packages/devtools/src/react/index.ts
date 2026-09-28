/**
 * What an app imports: one component, and the kit every panel is built from.
 *
 * ```tsx
 * <SyncmeshDevtools
 *   tabs={defaultTabs}
 *   source={() => createMeshSource(mesh)}
 *   dispose={(held) => held.close()}
 * />
 * ```
 *
 * Closed, that is a button and one keydown listener — see {@link SyncmeshDevtools}. The panels are
 * data: {@link defaultTabs} is the five this package ships, and an app can take four of them,
 * reorder them, or slot one of its own between them without a fork — see {@link DevtoolsTab}. What
 * they read is {@link DevtoolsSource}, and the whole non-React half is re-exported through here so
 * that a panel needs one import rather than two entry points and a rule about which is which.
 *
 * That includes `./dom`: this entry renders into a document, so an app that has already accepted
 * a renderer has already accepted a DOM, and splitting the sheet and the globals out of its
 * surface would buy nothing it could spend.
 */

export * from "../index.js";
export * from "../dom.js";

export type { SyncmeshDevtoolsProps } from "./devtools.js";
export { SyncmeshDevtools } from "./devtools.js";
export type {
  DevtoolsCorrection,
  DevtoolsReceipt,
  DeviceSwitchProps,
  EventsSource,
  LinksSource,
  MediumSwitchProps,
  StorageSource,
  WritesSource,
} from "../panels/index.js";
export {
  DeviceSwitch,
  Events,
  MediumSwitch,
  NoControls,
  Peers,
  Storage,
  Transports,
  Writes,
  defaultTabs,
  eventsTab,
  peersTab,
  storageTab,
  transportsTab,
  writesTab,
} from "../panels/index.js";
export type { ForcedBadgeProps } from "./forced.js";
export { ForcedBadge, forcedDetail, forcedLabel, useForced } from "./forced.js";
export type { FramesProps } from "./frames.js";
export { Frames, useFrames } from "./frames.js";
export type { PanelBoundaryProps } from "./boundary.js";
export { PanelBoundary } from "./boundary.js";
export type { Mounted } from "./mount.js";
export { mount } from "./mount.js";
export type { IconName, IconProps } from "./icons.js";
export { Icon } from "./icons.js";
export type { Shortcut } from "./use-shortcut.js";
export { DEFAULT_SHORTCUT, formatShortcut } from "./use-shortcut.js";

export type {
  Column,
  CrossProps,
  EmptyProps,
  FilterOption,
  MeterProps,
  NavProps,
  PanelProps,
  RingProps,
  RowProps,
  StatProps,
  StatusDotProps,
  TabItem,
  TableProps,
  TabsProps,
  TagProps,
  ToolbarProps,
} from "./primitives/index.js";
export {
  Cross,
  Crosshairs,
  Empty,
  Meter,
  Nav,
  Panel,
  Ring,
  Row,
  Stat,
  StatusDot,
  Table,
  Tabs,
  Tag,
  Toolbar,
} from "./primitives/index.js";

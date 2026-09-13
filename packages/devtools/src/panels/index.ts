/**
 * The panels this package ships, as data.
 *
 * An app installs them by passing {@link defaultTabs} to `SyncmeshDevtools`; it can also take four
 * of the five, reorder them, or put one of its own between them, because a tab is a value and not
 * a branch inside the shell. The shell never imports this file — that is the whole point of
 * {@link DevtoolsTab}.
 */

import type { DevtoolsSource } from "../contract.js";
import type { DevtoolsTab } from "../tabs.js";

import { eventsTab } from "./events.js";
import { peersTab } from "./peers.js";
import { storageTab } from "./storage.js";
import { transportsTab } from "./transports.js";
import { writesTab } from "./writes.js";

export type { EventsSource } from "./events.js";
export { Events, eventsTab } from "./events.js";
export type { LinksSource } from "./link-kit.js";
export { Peers, peersTab } from "./peers.js";
export type { StorageSource } from "./storage.js";
export { Storage, storageTab } from "./storage.js";
export type { DeviceSwitchProps, MediumSwitchProps } from "./medium-controls.js";
export { DeviceSwitch, MediumSwitch, NoControls } from "./medium-controls.js";
export { Transports, transportsTab } from "./transports.js";
export type { DevtoolsCorrection, DevtoolsReceipt, WritesSource } from "./writes.js";
export { Writes, writesTab } from "./writes.js";

/**
 * Ordered outward: who is on the mesh, what carries them, what has crossed, what it cost on disk,
 * and finally what this device wrote and is still waiting on. A developer who opens the panel to
 * answer "is anything connected" lands on the answer rather than three tabs away from it.
 */
export const defaultTabs = [
  peersTab,
  transportsTab,
  eventsTab,
  storageTab,
  writesTab,
] satisfies DevtoolsTab<DevtoolsSource>[];

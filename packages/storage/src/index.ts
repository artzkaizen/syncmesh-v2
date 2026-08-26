export type { SqlRow, SqlValue, SqliteDriver } from "./driver.js";
export { sqliteEventStore } from "./sqlite-event-store.js";
export { sqliteStateStore, type SqliteStateStoreOptions } from "./sqlite-state-store.js";
export { MalformedRecord, decodeRecord, encodeRecord } from "./record-codec.js";
export type { OpenStoresOptions, Stores } from "./open-stores.js";
export { openStores } from "./open-stores.js";
export type { CaptureOptions, Projection } from "./capture.js";
export {
  captureChanges,
  captureDdl,
  installCapture,
  tableDdl,
  tablesProjection,
} from "./capture.js";

export type {
  PostgresDriver,
  SqlDialect,
  SqlDriver,
  SqlRow,
  SqlValue,
  SqliteDriver,
} from "./driver.js";
export type { AsyncSqliteBinding, BoundSqlValue, SqliteBinding } from "./sqlite-driver.js";
export { asyncSqliteDriver, bindSqlite, sqliteDriver } from "./sqlite-driver.js";
export { sqlEventStore, sqliteEventStore, type SqlEventStoreOptions } from "./event-store.js";
export { LogCorrupt } from "./local-log.js";
export type {
  OperationOutcome,
  OperationRow,
  OperationStore,
  ReceiptRow,
} from "./operation-store.js";
export { operationStore } from "./operation-store.js";
export type { StoreLock } from "./lock.js";
export { acquireStoreLock, StoreLocked } from "./lock.js";
export type {
  LocalStorageEventStoreOptions,
  LocalStorageLike,
  OpenedLocalLog,
} from "./local-storage.js";
export { localStorageEventStore } from "./local-storage.js";
export {
  sqlStateStore,
  sqliteStateStore,
  type SqlStateStoreOptions,
  type SqliteStateStoreOptions,
} from "./state-store.js";
/** The record codec moved to `@syncmesh/wire`, where the other codecs live; re-exported here for the stores that write it. */
export { MalformedRecord, decodeRecord, encodeRecord } from "@syncmesh/wire";
export type { GrantStore } from "./grant-store.js";
export { memoryGrantStore, sqlGrantStore } from "./grant-store.js";
export type {
  OpenStoresOptions,
  ScopedStoreSet,
  ScopedStores,
  ScopedStoresOptions,
  StoreScope,
  Stores,
} from "./open-stores.js";
export {
  attachLog,
  logPathFor,
  openStores,
  scopedStores,
  storeFilesFor,
  storeNameFor,
} from "./open-stores.js";
export { DetachRefused, detachScope } from "./detach.js";
export type { RowSync } from "./row-sync.js";
export {
  ROW_SYNC_NOUN,
  ackedTableName,
  rowSyncTableName,
  operationOfSql,
  rowSyncDdlFor,
  rowSyncTable,
  syncOfSql,
} from "./row-sync.js";
export type { BudgetReport, StorageBudget } from "./budget.js";
export { sweepBudget } from "./budget.js";
export type { CaptureOptions } from "./capture.js";
export { captureChanges, captureDdl, installCapture, tableDdl } from "./capture.js";
export type { Projection, ProjectionOptions } from "./projection.js";
export { tablesProjection } from "./projection.js";
export type { BlobError, BlobHash, BlobStore } from "./blob.js";
export {
  BlobCorrupt,
  BlobNotFound,
  BlobTimeout,
  hashOf,
  memoryBlobStore,
  sqlBlobStore,
  verifyBlob,
} from "./blob.js";
export type { Compiled, CompileOptions } from "./read-filter.js";
export { columnScalarKind } from "./read-filter.js";
export type { PrincipalStatement, RlsOptions } from "./rls.js";
export { installRls, principalSettings, rlsDdl } from "./rls.js";
export { inTransaction, onConnection } from "./sql.js";
export { compileRead } from "./read-filter.js";
export type {
  TxReceipt,
  Write,
  WriteError as SqlWriteError,
  WriteLabel,
  WriteOptions as SqlWriteOptions,
  WriterDeps,
} from "./writer.js";
export { createWriter } from "./writer.js";

export { ATTACHED_LOG, LOG_TABLES, STATE_TABLES, logTable, stateTable } from "./dialect.js";

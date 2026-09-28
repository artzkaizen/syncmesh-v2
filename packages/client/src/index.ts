export type { AccountWriteError, AccountsConfig, AccountsDeps, MeshAccounts } from "./accounts.js";
export { openAccounts } from "./accounts.js";
export type { Booted, MeshOpenError } from "./boot.js";
export { openMeshEngine } from "./boot.js";
export { NoDefaultStore } from "./errors.js";
export type { Revision } from "./history.js";
export type { Blobs } from "./blobs.js";
export { NoSuchCapability } from "./blobs.js";
export type { Peer, Topic, Topics, ValueOf } from "./presence.js";
export { rowHistory } from "./history.js";
export type { DeliveredOptions, ReceivedOptions } from "./delivered.js";
export type {
  Handle,
  HistoryOptions,
  Mesh,
  MeshOptions,
  MeshSchema,
  MeshSchemaEntry,
  OnOptions,
  RevisionView,
  TxReceipt,
} from "./mesh.js";
export type { HandleCounts, Inspect, Teardown } from "./inspect.js";
export type { OperationsView } from "./operations.js";
export { openOperations, operationRefs, wireOperations } from "./operations.js";
export type { RecoveryIssue, RecoveryView } from "./recovery.js";
export type { Auth, AuthStatus, Session, SessionAsk, SessionProvider } from "./auth.js";
export { createAuth } from "./auth.js";
export type { Drafts } from "./drafts.js";
export { createDrafts, draftsDdl } from "./drafts.js";
export type { PeerEdge, PeerGraph, Peers } from "./peers.js";
export { createPeers } from "./peers.js";
export type { MeshHealth, MeshStatus, SourceStatus, Status } from "./status.js";
export { createStatus } from "./status.js";
export type {
  Checkpoint,
  ReadCoverage,
  ReadCoverageDeps,
  ReadCoverageView,
} from "./read-coverage.js";
export { LOCAL_ONLY, createReadCoverage } from "./read-coverage.js";
export { openRecovery } from "./recovery.js";
export type {
  MeshSweep,
  StoreSweep,
  SweepCandidate,
  SweepDeps,
  SweepReason,
  SweepOver,
  SweepRefusal,
  SweepReport,
} from "./sweep.js";
export { createSweep, sweepFor } from "./sweep.js";
export { createHandleTally } from "./inspect.js";
export type { SyncState } from "./sync-state.js";
export { createMesh } from "./mesh.js";
export type { GrantsRestored, IssueRequest, MeshGrants, StandingOf } from "./grants.js";
export { DeviceRevoked, NoGrantHeld, createMeshGrants, rememberGrants } from "./grants.js";
export type { ForcedMedium, Forcing, ForcingDeps } from "./forced.js";
export { NoSuchTransport, createForcing, standInFor } from "./forced.js";
/**
 * The shape `Mesh.onTelemetry` emits, exported because that method's signature already refers to it.
 *
 * A public type that names a type nobody can import is only nameable inside this package: any
 * consumer whose own inferred type touched it hit `TS2883 — the inferred type cannot be named
 * without a reference to 'MeshTelemetry'`, which `@syncmesh/devtools` did on every dts emit. The
 * build printed it and carried on with exit 0, so it sat there being reported and ignored.
 */
export type { MeshTelemetry } from "./telemetry.js";
export type { Knock, MeshShaping, RunningTransports } from "./transports.js";
export { TransportAddFailed, runTransports } from "./transports.js";
export { keyRingFor, transportContextFor } from "./transport-context.js";

export { DeviceKeyUnavailable, deviceIdentity, deviceIncarnation } from "./identity.js";

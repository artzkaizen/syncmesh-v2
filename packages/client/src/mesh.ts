import type { ColumnsMap, PresenceMap } from "@syncmesh/schema";
import type { BlobStore, SqlDialect, SqlValue, TxReceipt } from "@syncmesh/storage";
import type { SnapshotInstalled } from "@syncmesh/transport";

import { createHub } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { omitUndefined, Result, panic } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, supplyEntropy } from "@syncmesh/wire";

import type { Booted, MeshOpenError } from "./boot.js";
import type { MeshOptions } from "./options.js";
import type { Mesh } from "./surface.js";
import type { SweepOver } from "./sweep.js";
import type { RunningTransports } from "./transports.js";

import { openAccounts } from "./accounts.js";
import { openAuth } from "./auth.js";
import { openBlobs } from "./blobs.js";
import { openMeshEngine } from "./boot.js";
import { createPolicyQuestions } from "./can.js";
import { createDelivered, createReceived } from "./delivered.js";
import { openDocuments } from "./documents.js";
import { createDrafts } from "./drafts.js";
import { createFlush } from "./flush.js";
import { openGrants, restoreGrants, type MeshGrants } from "./grants.js";
import { openHandles, readableWith } from "./handles.js";
import { historyView } from "./history-view.js";
import { createHandleTally, createInspect, meterHandles } from "./inspect.js";
import { openInternal } from "./internal.js";
import { joinIfEmpty } from "./join.js";
import { narrowingFor, type watchNarrowing } from "./narrowing.js";
import { wireOperations } from "./operations.js";
import { createPeers } from "./peers.js";
import { openPresence } from "./presence.js";
import { createReadCoverage } from "./read-coverage.js";
import { openRecovery, recoveryDeps } from "./recovery.js";
import { followPhases } from "./session-marks.js";
import { bootSettings, checkTrust, splitStorage } from "./settings.js";
import { createStatus } from "./status.js";
import { createMeshSweep } from "./sweep.js";
import { createSyncStates } from "./sync-state.js";
import { createSynced } from "./synced.js";
import { followTelemetry } from "./telemetry.js";
import { keyRingFor, transportContextFor } from "./transport-context.js";
import { runTransports } from "./transports.js";
import { createMeshVisibility, gatedFor } from "./visibility.js";

export type { MeshOptions } from "./options.js";
export type { Handle, OnOptions } from "./handles.js";
export type { HistoryViewOptions as HistoryOptions, RevisionView } from "./history-view.js";
export type { Mesh, MeshSchema, MeshSchemaEntry } from "./surface.js";

export type { TxReceipt };

/**
 * Opens one mesh: opens (or is given) the stores, boots the engine over them, installs the tables
 * and capture, and hands out Drizzle handles per instance and principal. Async because boot is
 * (D05): the clock must pass every stored stamp before a write is numbered.
 *
 * **Not the app's constructor** (D47). An app calls `createClient` from `@syncmesh/orpc`, which
 * opens a mesh with this and puts procedures on top; this is reached through
 * `@syncmesh/client/internal` by the layers under the app — that client, adapters that serve a
 * mesh, and the harnesses that test one — and takes the same grouped options minus `procedures`.
 *
 * @example
 * import { createMesh } from "@syncmesh/client/internal";
 *
 * const mesh = (await createMesh({ schema, identity, storage: sqlite({ driver }) })).unwrap();
 */
export async function createMesh<
  C extends ColumnsMap,
  D extends SqlDialect = "sqlite",
  PC extends PresenceMap = Record<string, never>,
>(options: MeshOptions<C, D, PC>): Promise<Result<Mesh<D, PC>, MeshOpenError>> {
  const { identity, storage, trust = {} } = options;
  const { issuer, issuerKey, partitionKeys } = trust;
  checkTrust(trust);
  // before anything else: the first key this mesh mints must come from the source the app named
  if (options.entropy !== undefined) supplyEntropy(options.entropy);
  const now = options.now ?? (() => Temporal.Now.instant());
  const registry = createGrantRegistry({ issuer: issuer ?? identity.peerId, now });
  const { grants, bind } = openGrants(registry, {
    now,
    ...omitUndefined({ issuerKey, partitionKeys }),
  });
  // plain await, not Result.gen: a definition-time panic in `assemble` must reach the caller as itself
  const booted = await openMeshEngine(bootSettings(options, { now, grantFor: grants.grantFor }));
  if (booted.isErr()) return booted;
  bind(booted.value.engine);
  // before the grants are restored, so the restored own grant is the baseline a narrowing is
  // measured from, never a narrowing itself
  const { blobStore, narrowing } = narrowingFor(
    booted.value.engine,
    registry,
    omitUndefined({ identity, blobStore: storage?.blobs, onNarrowed: options.onNarrowed }),
  );
  // after boot, because the grants live in the database boot opens; before any session, because
  // a peer that reconnects first would meet a device that had forgotten who everyone is
  const remembered = await restoreGrants(registry, booted.value.driver, narrowing.idle);
  if (remembered.isErr()) return remembered;
  narrowing.closeAfter(remembered.value);
  // the grant writes queue behind purges (D45): closing the database under them would lose a
  // revocation or a renewal the app already made, so the close waits for both
  const close = async (): Promise<void> => {
    await narrowing.close();
    await booted.value.close();
  };
  const held = { ...booted.value, close };
  const sweep = splitStorage(storage).local?.sweep;
  return Result.ok(assemble(options, { grants, now, booted: held, blobStore, narrowing, sweep }));
}

interface Assembled {
  readonly grants: MeshGrants;
  readonly now: () => Temporal.Instant;
  readonly booted: Booted;
  readonly blobStore: BlobStore;
  readonly narrowing: ReturnType<typeof watchNarrowing>;
  /** The store set the mesh sheds through, when `storage` named one. */
  readonly sweep: SweepOver | undefined;
}

/** `mesh.transports`: the running links' add, remove, list, events and route forcing. */
const transportsSurface = (links: RunningTransports) => ({
  add: links.add,
  remove: links.remove,
  list: links.list,
  onLinkEvent: links.onLinkEvent,
  force: links.force,
  release: links.release,
  forced: links.forced,
});

function assemble<C extends ColumnsMap, D extends SqlDialect, PC extends PresenceMap>(
  options: MeshOptions<C, D, PC>,
  deps: Assembled,
): Mesh<D, PC> {
  const { schema, identity, trust } = options;
  const { grants, now, booted, blobStore, narrowing } = deps;
  const { engine } = booted;

  const tally = createHandleTally();
  const auth = openAuth(options.auth, now, async () => {
    // sync stops before the credential is dropped, never the other way round
    await flush();
    await links.stop();
  });
  const wiredDeps = { engine, self: identity.peerId, now };
  if (booted.operations !== undefined) Object.assign(wiredDeps, { store: booted.operations });
  const wired = wireOperations(wiredDeps);
  Object.assign(wired.extras, { sessionPrincipal: auth.principal });
  const keys = keyRingFor(identity, grants);
  Object.assign(wired.extras, { canRead: readableWith(schema, keys) });
  const on = meterHandles<D>(tally, openHandles<C, D, PC>(schema, booted, wired.extras));
  const flush = createFlush({ transports: () => links.list() });
  const snapshots = createHub<SnapshotInstalled>();
  const swept = createMeshSweep({ self: identity.peerId, grants, over: deps.sweep });
  const rescue = recoveryDeps(engine, identity.peerId, snapshots, () => links.list());
  const recovery = openRecovery(engine, { ...rescue, ...omitUndefined({ stores: swept.stores }) });
  const internal = openInternal({ engine, self: identity.peerId });

  // the watermark behind the `syncOf` column: one update per acknowledgement, however many rows
  // it settles. It answers nothing directly any more — the column is the read — but it is what
  // makes the column's answer move when a peer says it holds this device's writes
  const syncStates = createSyncStates(engine, identity.peerId, booted.rowSync);

  const shipped = { identity, ...trust };
  const { accounts, accountOf, author } = openAccounts(shipped, { engine, grants, now });
  const questions = createPolicyQuestions({ schema, engine, author });

  const history = historyView({ schema, store: booted.store, accountOf });

  const presence = openPresence(identity, schema.presence, { now, accountOf }, (wire) =>
    links.sendPresence(wire),
  );
  const blobs = openBlobs(tally, blobStore, () => links.withBlobs());
  const telemetry = followTelemetry(engine);
  const transportContext = transportContextFor({
    engine,
    identity,
    grants,
    now,
    onPresence: (wire) => void presence.receive(wire),
    // the two halves of signed custody (D28): what this device can vouch for out of its own
    // store, and where a peer's vouch for this device's writes lands. A mesh over a bare event
    // store has neither, and passes neither, rather than passing a sink with nowhere to write
    ...omitUndefined({ incarnation: booted.incarnation }),
    ...wired.custody,
    onSnapshot: (installed) => snapshots.emit(installed),
    servesAuthority: trust?.authority === identity.peerId,
    // the gated tables, which reach a device only through the authority's gate (D24)
    ...gatedFor(schema, trust?.authority),
    purge: narrowing.purge,
    // one record for every session, so a request count outlives the link it was made on (D46)
    rejoins: rescue.rejoins,
    keys,
    sealedKinds: schema.sealedKinds,
    // our own partitions, which is what the door's grant-derived default compares against
    partitions: () => (grants.grantFor(identity.peerId)?.partitions ?? []).map(String),
    ...omitUndefined({
      shaping: options.mesh,
      onGrantRequest: options.admission,
      // the same anchor grants are checked against: a snapshot is state nobody signed per event, so
      // the certificate over it is the only thing that can make it more than provisional
      trust: trust?.issuer,
      certificate: options.certificate,
      // a granted mesh gates reads on every link (D40)
      issuer: trust?.issuer,
    }),
  });
  const { routes } = transportContext;
  // the log's session follows the app into the background and back (D39)
  const phases = followPhases(booted.session);
  const links = runTransports(
    options.transports ?? [],
    transportContext,
    options.mesh ?? {},
    options.knocks ?? [],
    omitUndefined({ start: options.start, onPhase: phases.phase }),
  );
  // a device holding nothing asks for state instead of history; one that holds coverage does not
  void joinIfEmpty(engine, { ready: links.ready, list: links.list });
  const docs = openDocuments(engine, schema, options.documents, {
    blobs,
    store: blobStore,
    links,
  });

  const surface: Mesh<D, PC> = {
    engine,
    grants,
    // the manifest itself, narrowed by the type: there is nothing to project and so nothing to
    // fall out of step with what the validator and the fold are reading
    schema,
    on,
    history,
    // SAFETY: table names and keys are opaque strings in the kernel — the same laundering
    // `historyView` does for the identical pair
    deletedAt: (table, key) => engine.deletedAt(table as never, key as never),
    presence: (instance) => {
      const partition = parsePartitionKey(instance);
      if (partition.isErr()) panic(`presence: ${partition.error.message}`);
      return presence.at<PC>(partition.value);
    },
    blobs,
    visibility: createMeshVisibility(() => links.list()),
    accounts,
    corrections: internal.corrections,
    can: questions.can,
    delivered: createDelivered(engine, identity.peerId),
    received: createReceived(engine),
    synced: createSynced(() => links.list()),
    revert: (id) => engine.revert(id),
    canRevert: (id) => engine.canRevert(id),
    internal,
    recovery,
    auth,
    routes,
    peers: createPeers({ self: identity.peerId, transports: links.list }),
    status: createStatus({
      transports: links.list,
      online: links.online,
      recovery,
      settled: links.settled,
    }),
    inspect: createInspect({ tally, links, booted, engine, now, why: questions.why, telemetry }),
    flush,
    onTelemetry: (listener) => tally.wrap("subscriptions", telemetry(listener)),
    ready: links.ready,
    settled: links.settled,
    coverage: createReadCoverage({
      transports: links.list,
      cursors: () => engine.coverage().synced,
      now,
    }),
    running: links.running,
    start: links.start,
    requestGrant: (invite) => {
      swept.asked();
      links.requestGrant(invite);
    },
    transports: transportsSurface(links),
    stop: async () => {
      await docs?.stop(); // a paced burst goes, and a blob offer under way ends, before transports close
      swept.stop();
      wired.stop();
      syncStates.stop();
      presence.stop(); // an explicit departure, so peers see this device leave now
      // flush before the medium closes: the save at the end of a transport's queue is exactly
      // what a process exiting loses, and closing first would lose it every time
      await flush();
      await links.stop();
      await Promise.all([rescue.torn.stop(), phases.settled()]);
      await booted.close();
    },
  };
  if (wired.view !== undefined) Object.assign(surface, { operations: wired.view });
  if (docs !== undefined) Object.assign(surface, { docs: docs.documents });
  // drafts and the read-only door both live on the app's own connection; a mesh over a bare
  // event store keeps neither, and says so by leaving them absent
  if (booted.driver !== undefined) {
    const { driver } = booted;
    Object.assign(surface, {
      drafts: createDrafts(driver),
      query: (sql: string, params?: readonly SqlValue[]) => driver.all(sql, params),
    });
  }
  return surface;
}

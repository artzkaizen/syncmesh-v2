import type { ColumnsMap, PresenceMap } from "@syncmesh/schema";
import type { SqlDialect, SqlValue, TxReceipt } from "@syncmesh/storage";
import type { SnapshotInstalled } from "@syncmesh/transport";

import { createHub } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { omitUndefined, Result, panic } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry } from "@syncmesh/wire";

import type { Booted, MeshOpenError } from "./boot.js";
import type { MeshOptions } from "./options.js";
import type { Mesh } from "./surface.js";

import { openAccounts } from "./accounts.js";
import { openAuth } from "./auth.js";
import { openBlobs } from "./blobs.js";
import { openMeshEngine } from "./boot.js";
import { createCan } from "./can.js";
import { createDelivered, createReceived } from "./delivered.js";
import { createDrafts } from "./drafts.js";
import { createFlush } from "./flush.js";
import { openGrants, restoreGrants, type MeshGrants, type MeshGrantsOptions } from "./grants.js";
import { openHandles, readableWith } from "./handles.js";
import { historyView } from "./history-view.js";
import { createHandleTally, linksAcross, meterHandles } from "./inspect.js";
import { openInternal } from "./internal.js";
import { joinIfEmpty } from "./join.js";
import { wireOperations } from "./operations.js";
import { createPeers } from "./peers.js";
import { openPresence } from "./presence.js";
import { createReadCoverage } from "./read-coverage.js";
import { openRecovery, recoveryDeps } from "./recovery.js";
import { createStatus } from "./status.js";
import { sweepFor } from "./sweep.js";
import { createSyncStates } from "./sync-state.js";
import { followTelemetry } from "./telemetry.js";
import { keyRingFor, transportContextFor } from "./transport-context.js";
import { runTransports } from "./transports.js";

export type { MeshOptions } from "./options.js";
export type { Handle, OnOptions } from "./handles.js";
export type { HistoryViewOptions as HistoryOptions, RevisionView } from "./history-view.js";
export type { Mesh, MeshSchema, MeshSchemaEntry } from "./surface.js";

export type { TxReceipt };

/**
 * One constructor: opens (or is given) the stores, boots the engine over them, installs the
 * tables and capture, and hands out Drizzle handles per instance and principal. Async because
 * boot is (D05): the clock must pass every stored stamp before a write is numbered.
 */
export async function createMesh<
  C extends ColumnsMap,
  D extends SqlDialect = "sqlite",
  PC extends PresenceMap = Record<string, never>,
>(options: MeshOptions<C, D, PC>): Promise<Result<Mesh<D, PC>, MeshOpenError>> {
  const { identity, issuer, issuerKey } = options;
  if (issuerKey !== undefined && issuerKey.peerId !== issuer)
    panic(
      "issuerKey does not match issuer: the private half must belong to the configured root of trust",
    );
  // the same shape one table over: a key whose feature is off signs rows this peer will never
  // read, and a mesh half-configured that way looks like one where links simply do not work
  if (options.accountKey !== undefined && options.accounts !== true)
    panic("accountKey does not match accounts: links are only read where `accounts: true` is set");
  const now = options.now ?? (() => Temporal.Now.instant());
  const registry = createGrantRegistry({ issuer: issuer ?? identity.peerId, now });
  const grantsOptions = { now } satisfies MeshGrantsOptions;
  if (issuerKey !== undefined) Object.assign(grantsOptions, { issuerKey });
  const { grants, bind } = openGrants(registry, grantsOptions);
  // plain await, not Result.gen: a definition-time panic in `assemble` must reach the caller as itself
  const booted = await openMeshEngine({
    ...options,
    dataDir: options.dataDir ?? ".syncmesh",
    now,
    grantFor: grants.grantFor,
  });
  if (booted.isErr()) return booted;
  bind(booted.value.engine);
  // after boot, because the grants live in the database boot opens; before any session, because
  // a peer that reconnects first would meet a device that had forgotten who everyone is
  const remembered = await restoreGrants(registry, booted.value.driver);
  if (remembered.isErr()) return remembered;
  return Result.ok(assemble(options, { grants, now, booted: booted.value }));
}

interface Assembled {
  readonly grants: MeshGrants;
  readonly now: () => Temporal.Instant;
  readonly booted: Booted;
}

function assemble<C extends ColumnsMap, D extends SqlDialect, PC extends PresenceMap>(
  options: MeshOptions<C, D, PC>,
  deps: Assembled,
): Mesh<D, PC> {
  const { schema, identity } = options;
  const { grants, now, booted } = deps;
  const { engine } = booted;
  const entryOf = new Map(schema.entries.map((e) => [String(e.table.name), e]));

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
  const swept = sweepFor({ self: identity.peerId, grants, over: options.sweep });
  const recovery = openRecovery(engine, {
    ...recoveryDeps(engine, identity.peerId, snapshots, () => links.list()),
    ...omitUndefined({ stores: swept.stores }),
  });
  const internal = openInternal({ engine, self: identity.peerId });

  // the watermark behind the `syncOf` column: one update per acknowledgement, however many rows
  // it settles. It answers nothing directly any more — the column is the read — but it is what
  // makes the column's answer move when a peer says it holds this device's writes
  const syncStates = createSyncStates(engine, identity.peerId, booted.rowSync);

  const { accounts, accountOf, author } = openAccounts(options, { engine, grants, now });

  const history = historyView({ schema, store: booted.store, accountOf });

  const presence = openPresence(identity, schema.presence, { now, accountOf }, (wire) =>
    links.sendPresence(wire),
  );
  const blobs = openBlobs(tally, options.blobStore, () => links.withBlobs());
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
    ...omitUndefined({ incarnation: booted.incarnation, onReceipt: wired.vouched }),
    onSnapshot: (installed) => snapshots.emit(installed),
    servesAuthority: options.authority === identity.peerId,
    keys,
    // our own partitions, which is what the door's grant-derived default compares against
    partitions: () => (grants.grantFor(identity.peerId)?.partitions ?? []).map(String),
    ...omitUndefined({
      shaping: options.mesh,
      onGrantRequest: options.onGrantRequest,
      // the same anchor grants are checked against: a snapshot is state nobody signed per event, so
      // the certificate over it is the only thing that can make it more than provisional
      trust: options.issuer,
      certificate: options.certificate,
    }),
  });
  const { routes } = transportContext;
  const links = runTransports(
    options.transports ?? [],
    transportContext,
    options.mesh ?? {},
    options.knocks ?? [],
  );
  // a device holding nothing asks for state instead of history; one that holds coverage does not
  void joinIfEmpty(engine, { ready: links.ready, list: links.list });

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
    accounts,
    corrections: internal.corrections,
    can: createCan({
      schema,
      engine,
      author,
      kindOf: (table) => entryOf.get(table)?.partition,
    }),
    delivered: createDelivered(engine, identity.peerId),
    received: createReceived(engine),
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
    inspect: {
      handles: () => tally.counts(linksAcross(links.list())),
    },
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
    requestGrant: (invite) => {
      swept.asked();
      links.requestGrant(invite);
    },
    transports: {
      add: links.add,
      remove: links.remove,
      list: links.list,
      onLinkEvent: links.onLinkEvent,
      force: links.force,
      release: links.release,
      forced: links.forced,
    },
    stop: async () => {
      swept.stop();
      wired.stop();
      syncStates.stop();
      presence.stop(); // an explicit departure, so peers see this device leave now
      // flush before the medium closes: the save at the end of a transport's queue is exactly
      // what a process exiting loses, and closing first would lose it every time
      await flush();
      await links.stop();
      await booted.close();
    },
  };
  if (wired.view !== undefined) Object.assign(surface, { operations: wired.view });
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

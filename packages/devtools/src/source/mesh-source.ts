import type { Mesh } from "@syncmesh/client";
import type { Unsubscribe } from "@syncmesh/engine";

import { createInspector } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { DevtoolsSource } from "../contract.js";
import type { ChannelOptions } from "./channels.js";
import type { StoreDialect } from "./store.js";

import { createChannels } from "./channels.js";
import { grantsOf } from "./grants.js";
import { identityOf, overviewOf } from "./health.js";
import { createLabelReader } from "./labels.js";
import { createLinkRing } from "./link-ring.js";
import { watchMediums } from "./mediums.js";
import { createSqlDoor } from "./sql.js";
import { createStoreReader } from "./store.js";
import { syncOf } from "./sync.js";
import { linksOf, schemaOf } from "./topology.js";
import { createWritesReader, strandedRows } from "./writes.js";

/**
 * One live mesh, as much of it as a panel may see, behind one set of subscriptions.
 *
 * **The subscription count is the design.** `engine.onFoldBatch` and `engine.onTelemetry` run
 * synchronously inside the write path, so every listener attached to them is a cost the app's
 * users pay on every write they make and every batch they receive. This source takes exactly
 * three engine hooks for the whole devtool — folds, acknowledgements, quarantine — plus one
 * telemetry listener feeding a single {@link createInspector}, plus the link feed. Each of the
 * first three does one thing: add a string to a set that already exists. A design with a
 * subscription per panel would multiply that by however many panels an app happened to install,
 * which is the sort of cost that is invisible in development and obvious on a phone.
 *
 * The cheap feeds — routes, grants, auth, the write ledger — are subscribed here too, not because
 * they are expensive but because a panel that may hold *one* subscription is a panel that cannot
 * leak a second one. `onChange` is the whole seam.
 *
 * Nothing here mutates. There is no `run`, no `rebuild`, no `add`, no `remove`, and no path to
 * `engine.mutate` — an operator action is a surface a host app opts into deliberately, and a
 * devtool that can change the thing it is measuring is a devtool whose readings mean less.
 */

export interface MeshSourceOptions extends ChannelOptions {
  /** Defaults to the ambient clock; injectable so a test can be sure what "expired" means. */
  readonly now?: () => Temporal.Instant;
  /** How many link endings to keep. Default {@link LINK_HISTORY}. */
  readonly keepLinkEvents?: number;
  /**
   * Which set of table names the database uses. Absent, the store reader asks it once — nothing on
   * `Mesh` says, because `query` is the driver's `all` and deliberately nothing else.
   */
  readonly dialect?: StoreDialect;
}

export function createMeshSource(mesh: Mesh, options: MeshSourceOptions = {}): DevtoolsSource {
  const now = options.now ?? (() => Temporal.Now.instant());
  const channels = createChannels(options);
  const ring = createLinkRing(options.keepLinkEvents);
  // one `onStatus` per medium, reconciled with the live set on every read — the only reading of
  // "is this radio up" a mesh surface will not hand over, and the one `$status` folds away
  const mediums = watchMediums(mesh, () => channels.moved("link"));
  const inspector = createInspector();

  /**
   * `settled()` is a promise nothing re-announces, so it is awaited once and read as a flag. A
   * rejection is not a third state: every source that could still fill a scope has either
   * finished or has not, and a transport that failed to start is the health's business.
   */
  let settled = false;
  void mesh.settled().then(
    () => (settled = true),
    () => undefined,
  );

  const held: Unsubscribe[] = [
    // the three hot ones. Each adds a string to a set; see `createChannels` for why that matters
    mesh.engine.onFoldBatch(() => channels.moved("fold")),
    mesh.engine.onAcknowledge(() => channels.moved("ack")),
    mesh.engine.onQuarantine(() => channels.moved("quarantine")),
    // the one reader of the telemetry union, so `fold` never pays for a second counter
    mesh.onTelemetry(inspector.note),
    // the only feed that retains anything, because it is the only one that is not a snapshot
    mesh.transports.onLinkEvent((event) => {
      ring.note(event);
      channels.moved("link");
    }),
    mesh.routes.onChange(() => channels.moved("route")),
    mesh.grants.onRegistered(() => channels.moved("grant")),
    mesh.grants.onForgotten(() => channels.moved("grant")),
    mesh.auth.subscribe(() => channels.moved("auth")),
  ];
  const ledger = mesh.operations;
  if (ledger !== undefined) held.push(ledger.onChange(() => channels.moved("writes")));

  const query = mesh.query;
  // one memo for the source, not one per read: a label never changes, so an event is asked once
  const named = createLabelReader(mesh.operations, mesh.engine.peerId);

  return {
    identity: () => identityOf(mesh),
    overview: () => overviewOf(mesh, { settled: () => settled, mediums: mediums.list }),
    sync: () => syncOf(mesh),
    links: () => linksOf(mesh, ring),
    schema: () => schemaOf(mesh),
    events: async (recent) => {
      const page = await mesh.engine.recentEvents(recent);
      return page.isErr() ? page : Result.ok(await named(page.value));
    },
    storage: query === undefined ? undefined : createStoreReader(query, options.dialect),
    writes: ledger === undefined ? undefined : createWritesReader(ledger),
    stranded: async () => (await mesh.recovery.stranded()).map(strandedRows),
    grants: () => grantsOf(mesh, now),
    timings: inspector.stats,
    sql: query === undefined ? undefined : createSqlDoor(query),
    onChange: channels.subscribe,
    close: () => {
      for (const release of held) release();
      held.length = 0;
      mediums.close();
      channels.close();
    },
  };
}

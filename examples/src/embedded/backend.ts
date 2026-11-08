import { createMesh } from "@syncmesh/client";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import {
  schemaName,
  sqlEventStore,
  sqlStateStore,
  statePath,
  tableDdl,
  tablesProjection,
} from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";

import { serverIdentity } from "../identity.js";
import { INSTANCE, INVITE, ROOM, notesSchema } from "../notes.js";

export interface BackendOptions {
  /** Where the app's own SQLite file and the relay's room logs live. */
  readonly dataDir: string;
  /** The port the in-process relay listens on; 0 picks a free one. Ignored with `relayUrl`. */
  readonly relayPort?: number;
  /**
   * A relay somebody else runs. Given, this process starts none of its own — the same server
   * peer then serves shape B, where the relays are containers behind a load balancer.
   */
  readonly relayUrl?: string;
  /** Called once per grant decision, for a console or a test to watch. */
  readonly onGrant?: (line: string) => void;
}

/**
 * Shape A in one call (D09-A, API.md §14-A): `startRelay()` serves the room, and
 * `createMesh({ store, stateStore })` is the server peer that folds what devices write into the
 * app's own `notes` table. What `server.ts` runs, and what the example's test drives.
 */
export async function openBackend(options: BackendOptions) {
  const { dataDir } = options;
  mkdirSync(dataDir, { recursive: true });
  /**
   * The mesh's connection keeps the log in `app.db` and the rows in the state file beside it —
   * `app.db.state@<schema>`, which is where `notes` lives. The app's own Drizzle has to open that
   * one: the log file holds no table of yours.
   */
  const logFile = `${dataDir}/app.db`;
  const tablesFile = statePath(logFile, schemaName([]));

  // 1 · the relay, in this process. Its room log is its own SQLite under dataDir — the relay is
  // a peer, and this is its copy.
  const relay =
    options.relayUrl === undefined
      ? await startRelay(options.relayPort ?? 0, { dataDir: `${dataDir}/relay` })
      : undefined;
  const dialing = options.relayUrl ?? `${relay?.url}/${ROOM}`;

  // 2 · your database and your Drizzle over it, exactly as your backend already had them. A
  // second connection to the file the mesh writes below — ordinary for SQLite in WAL mode, and on
  // Postgres it would be two clients on one pool.
  const db = drizzle({ client: new Database(tablesFile, { create: true }) });

  // 3 · the mesh's own connection to that same file. `store` is the event log, `stateStore` is
  // where a fold lands: the sidecar it needs for stamps, plus a projection that UPSERTs each
  // changed row into `notes` — the table above, readable with plain SQL.
  const driver = bunSqliteDriver(logFile);
  const schema = notesSchema();
  const tables = schema.entries.map((entry) => entry.table);
  for (const table of tables) await driver.run(tableDdl(table));
  const store = (await sqlEventStore(driver)).unwrap();
  const stateStore = (
    await sqlStateStore(driver, { projection: tablesProjection(driver, tables) })
  ).unwrap();

  const identity = serverIdentity();
  const server = (
    await createMesh({
      schema,
      identity,
      // this process is the room's root of trust: it holds the issuer key and answers grant requests
      issuer: identity.peerId,
      issuerKey: identity,
      store,
      stateStore,
      transports: [relayTransport({ dial: webSocketDial(dialing) })],
      // flow A: an ungranted device asked the room to exist. A real approval screen goes here —
      // the invite is the only thing binding this request to someone who was actually invited.
      onGrantRequest: ({ peerId, invite }) => {
        if (invite !== INVITE) {
          options.onGrant?.(`refused ${peerId.slice(0, 8)}: wrong invite`);
          return;
        }
        const wire = server.grants.issue({
          account: `acct_${peerId.slice(0, 8)}`,
          device: peerId,
          role: "member",
          partitions: [INSTANCE],
          validFor: Temporal.Duration.from({ days: 1 }),
        });
        options.onGrant?.(
          wire.isOk() ? `granted ${peerId.slice(0, 8)}` : `refused: ${wire.error.message}`,
        );
      },
    })
  ).unwrap();
  await server.ready();

  return {
    db,
    server,
    issuer: identity.peerId,
    /** What a device dials. */
    dialing,
    /** Ours, or `undefined` when `relayUrl` named somebody else's. */
    relay,
    stop: async (): Promise<void> => {
      await server.stop();
      await relay?.stop();
      await driver.close?.();
    },
  };
}

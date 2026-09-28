import { createMesh } from "@syncmesh/client";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { sqlEventStore, sqlStateStore, tableDdl, tablesProjection } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";

import { serverIdentity } from "../identity.js";
import { INSTANCE, INVITE, ROOM, notes, notesSchema } from "../notes.js";

const RELAY_PORT = Number(Bun.env.RELAY_PORT ?? 5198);
const API_PORT = Number(Bun.env.API_PORT ?? 5199);
const DATA_DIR = Bun.env.DATA_DIR ?? ".syncmesh/example";
const APP_DB = `${DATA_DIR}/app.db`;
/**
 * Given, this process joins a relay somebody else is running and starts none of its own — which
 * is how the same server peer serves shape B, where the relays are in containers behind a load
 * balancer and the only thing missing from that compose file is the holder of the issuer key.
 */
const RELAY_URL = Bun.env.RELAY_URL;

mkdirSync(DATA_DIR, { recursive: true });

// 1 · the relay, in this process. No second deployment: phones dial ws://localhost:5198/acme.
// Its room log is its own SQLite under dataDir — the relay is a peer, and this is its copy.
const relay =
  RELAY_URL === undefined
    ? await startRelay(RELAY_PORT, { dataDir: `${DATA_DIR}/relay` })
    : undefined;
const dialing = RELAY_URL ?? `ws://localhost:${RELAY_PORT}/${ROOM}`;

// 2 · your database and your Drizzle over it, exactly as your backend already had them. This is
// a second connection to the file the mesh writes below — ordinary for SQLite in WAL mode, and
// on Postgres it would be two clients on one pool.
const db = drizzle({ client: new Database(APP_DB, { create: true }) });

// 3 · the mesh's own connection to that same file. `store` is the event log, `stateStore` is
// where a fold lands: the sidecar it needs for stamps, plus a projection that UPSERTs each
// changed row into `notes` — the table above, in your database, readable with plain SQL.
const driver = bunSqliteDriver(APP_DB);
const schema = notesSchema();
const tables = schema.entries.map((entry) => entry.table);
for (const table of tables) await driver.run(tableDdl(table));

const store = await sqlEventStore(driver);
const stateStore = await sqlStateStore(driver, { projection: tablesProjection(driver, tables) });

const identity = serverIdentity();
const server = (
  await createMesh({
    schema,
    identity,
    // this process is the room's root of trust: it holds the issuer key and answers grant requests
    issuer: identity.peerId,
    issuerKey: identity,
    store: store.unwrap(),
    stateStore: stateStore.unwrap(),
    transports: [relayTransport({ dial: webSocketDial(dialing) })],
    // flow A: an ungranted device asked the room to exist. A real approval screen goes here —
    // the invite is the only thing binding this request to someone who was actually invited.
    onGrantRequest: ({ peerId, invite }) => {
      if (invite !== INVITE) return;
      const wire = server.grants.issue({
        account: `acct_${peerId.slice(0, 8)}`,
        device: peerId,
        role: "member",
        partitions: [INSTANCE],
        validFor: Temporal.Duration.from({ days: 1 }),
      });
      console.log(
        wire.isOk() ? `granted ${String(peerId).slice(0, 8)}` : `refused: ${wire.error.message}`,
      );
    },
  })
).unwrap();

await server.ready();

// 4 · your app, untouched: an ordinary SELECT over the table the fold writes
const api = Bun.serve({
  port: API_PORT,
  fetch: async () => Response.json(await db.select().from(notes)),
});

console.log(`relay   ${dialing}${relay === undefined ? "  (not ours: RELAY_URL is set)" : ""}`);
console.log(`api     http://localhost:${API_PORT}/  (GET: the notes table, straight from SQLite)`);
console.log(`issuer  ${identity.peerId}`);
console.log(`invite  ${INVITE}`);
console.log(`\nrun a device:  bun run device alice "first note"`);

const stop = async (): Promise<void> => {
  await api.stop(true);
  await server.stop();
  await relay?.stop();
  await driver.close?.();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

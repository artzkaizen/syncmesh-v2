import { createApp, createHandler } from "@syncmesh/orpc";
import { relayTransport, webSocketDial } from "@syncmesh/relay";
import { nodeSqliteDriver } from "@syncmesh/sqlite-node";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { mkdirSync } from "node:fs";

import { PRACTICE, procedures, roundsSchema } from "../rounds.js";

/**
 * The mesh, on the server.
 *
 * A browser has no SQLite — `sqlite-wasm` over OPFS is unbuilt (E04) — so it cannot hold the
 * ward's partition and cannot run a read locally. This process can: it opens the partition, joins
 * the relay, and answers the browser's calls against it. The browser runs the *same procedures*,
 * one HTTP hop away.
 *
 * Which makes the honest description of this app **not local-first**. It is a normal web app on
 * top of a mesh node, and the reason to build it is that the ward's phones are on the same relay:
 * a reading taken on a phone with no signal appears here when it syncs, without this server ever
 * polling anything.
 */

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);
// `import.meta.env`, not `Bun.env` or `process.env`: this module is bundled by Vite and runs
// under Node in dev, so the runtime's own global is the one thing it cannot assume.
const RELAY_URL = import.meta.env["VITE_RELAY_URL"] ?? "ws://localhost:5198/rounds";

/** Demo keys. A real deployment mints the issuer in a secret manager and the device once, on boot. */
const issuer = createIdentity(seed(1)).unwrap();
const station = createIdentity(seed(200)).unwrap();

mkdirSync(".syncmesh", { recursive: true }); // `bunSqliteDriver` opens a file, it does not make a directory

export const { api, mesh } = await createApp({
  schema: roundsSchema(),
  procedures,
  instance: PRACTICE,
  identity: station,
  issuer: issuer.peerId,
  // `node:sqlite`, not `bun:sqlite`: Vite's dev server runs this module under Node, and a web
  // app should not be tied to one runtime anyway. Bun implements `node:sqlite` too, so the same
  // driver serves both.
  driver: nodeSqliteDriver(".syncmesh/rounds-web.db"),
  transports: [relayTransport({ dial: webSocketDial(RELAY_URL) })],
});

mesh.grants
  .register(
    issueGrant(issuer, {
      account: "acct_station",
      device: station.peerId,
      role: "clinician",
      // SAFETY: the ward this app serves, in the documented kind:id form
      partitions: [PRACTICE] as never,
      validFor: Temporal.Duration.from({ days: 1 }),
      // the real clock: this server runs on it, and a grant minted at a fixed instant is born expired
      now: Temporal.Now.instant(),
    }),
  )
  .unwrap();

await mesh.settled();

/** One POST, carrying a path and an input. Every browser call arrives here. */
export const handle = createHandler({ procedures, api });

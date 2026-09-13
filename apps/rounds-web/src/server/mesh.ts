import { createApp, createHandler } from "@syncmesh/orpc";
import { relayTransport, webSocketDial } from "@syncmesh/relay";
import { nodeSqliteDriver } from "@syncmesh/sqlite-node";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { mkdirSync } from "node:fs";

import { PRACTICE, procedures, roundsSchema } from "../rounds.js";

/**
 * The mesh, on the server — now a choice rather than a constraint.
 *
 * This used to say a browser has no SQLite. It does now: `@syncmesh/sqlite-wasm` holds a
 * partition over OPFS on the page's own thread, so a browser can run a read locally and this app
 * *could* be local-first.
 *
 * It still is not, and the reason is what this screen is. A ward display is a shared, fixed,
 * signed-in-once terminal, not somebody's device: giving it a replica of its own would mean a
 * second copy of the ward's data on a machine in a corridor, an OPFS quota to manage and a
 * leader election between tabs, to save a hop on a wired connection that is never offline. The
 * phones are where local-first earns its cost, and they are on the same relay — a reading taken
 * with no signal appears here when it syncs, without this server polling anything.
 *
 * So the honest description is unchanged: **a normal web app on top of a mesh node.** What
 * changed is that it is now a decision with a reason, and `apps/issues` is where the browser
 * replica is actually exercised.
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

import { createServer, sqlite } from "@syncmesh/orpc";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { mkdirSync } from "node:fs";

import { procedures } from "../procedures.js";
import { issuesSchema } from "../schema.js";

/**
 * What two installs of this tracker meet on — `bun run --cwd apps/issues relay`.
 *
 * **`createServer` with no `handlers`**, which is the whole definition of a relay (book ch. 22):
 * it keeps a copy and is always on, verifies signatures and judges nothing, holds no issuer key,
 * and every device on it holds the whole room. The authority beside it is the same call with one
 * more argument — a body for the one decision a device cannot make for itself. There is no second
 * kind of node here, and `startRelay` is no longer a second entry point pretending there is.
 *
 * **A second process beside the dev server, started by hand, and that is the point.** Folding it
 * into `vp dev` would make convergence something the app appears to have rather than something it
 * is given, and the first question anybody asks of a local-first demo is what happens when the
 * server is not there. Two terminals answers it: stop this one and the app keeps working, says
 * `Relay unreachable`, and picks up where it left off when it comes back.
 */

/** One room per path, and this app is one room — the name `app/relay.ts` dials. */
const ROOM = "issues";
const PORT = Number(Bun.env["PORT"] ?? 5241);

mkdirSync(".syncmesh", { recursive: true });

const server = await createServer({
  schema: issuesSchema(),
  procedures,
  // no `handlers`: this node decides nothing, which is what makes it a relay
  storage: sqlite({ driver: bunSqliteDriver(".syncmesh/relay.db") }),
  custody: { port: PORT, dataDir: ".syncmesh/relay" },
});

console.log(
  `relay on ${server.serving?.url ?? `ws://localhost:${String(PORT)}`}/${ROOM} — the app dials this unless VITE_RELAY_URL says otherwise`,
);

const stop = async (): Promise<void> => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

import { createPlaintextVault } from "@syncmesh/client";
import { createServer, sqlite } from "@syncmesh/orpc";
import { postgresFanout } from "@syncmesh/relay";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { mkdirSync } from "node:fs";

import { roundsSchema } from "../rounds/schema.js";
import { fanoutConnection } from "./postgres.js";

const port = Number(Bun.env.PORT ?? 5198);
const dataDir = Bun.env.DATA_DIR ?? ".syncmesh/relay";
const name = Bun.env.INSTANCE_NAME ?? `relay:${port}`;
const url = Bun.env.DATABASE_URL ?? "postgres://syncmesh:syncmesh@localhost:5432/syncmesh";

/**
 * One instance of the fleet: `createServer` with no `handlers`, which is the whole definition of
 * a relay (book ch. 22). Its room log is its own — a volume per container, never shared — and
 * Postgres is a **transport between instances**, not the relay's storage.
 */
mkdirSync(dataDir, { recursive: true }); // the driver opens a file; it does not make a directory
const fanout = await fanoutConnection(url);
const server = await createServer({
  // the manifest's partition half is all a pure-custody node reads: it holds rooms, not rows
  schema: roundsSchema(),
  storage: sqlite({ driver: bunSqliteDriver(`${dataDir}/node.db`) }),
  // a container has no keystore: the instance's own key sits in its volume in plaintext, and every
  // boot says so. A deployment that has a secret manager passes `createSecretStoreVault` over it
  vault: createPlaintextVault(),
  custody: {
    port,
    dataDir,
    fanout: postgresFanout({
      client: fanout,
      // both sides of the same outage: what this instance could not send, and what another
      // instance could not send it. Neither recovers the frame — a device that holds the event
      // connecting here does — but a fleet can see it happening from either end
      onOversize: (bytes) => console.warn(`${name}: frame too large to fan out (${bytes}B)`),
      onGap: () =>
        console.warn(`${name}: another instance is ahead by something it could not send`),
    }),
  },
});

console.log(`${name} serving ${server.serving?.url ?? port}, fanning out over ${url}`);

const stop = async (): Promise<void> => {
  await server.stop();
  await fanout.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

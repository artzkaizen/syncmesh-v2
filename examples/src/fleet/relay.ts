import { createServer, sqlite } from "@syncmesh/orpc";
import { postgresFanout } from "@syncmesh/relay";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";

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
const fanout = await fanoutConnection(url);
const server = await createServer({
  // the manifest's partition half is all a pure-custody node reads: it holds rooms, not rows
  schema: roundsSchema(),
  procedures: {},
  storage: sqlite({ driver: bunSqliteDriver(`${dataDir}/node.db`) }),
  custody: { port, dataDir, fanout: postgresFanout({ client: fanout }) },
});

console.log(`${name} serving ${server.serving?.url ?? port}, fanning out over ${url}`);

const stop = async (): Promise<void> => {
  await server.stop();
  await fanout.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

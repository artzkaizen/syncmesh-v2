import { omitUndefined } from "@syncmesh/result";

import { INVITE, notes } from "../notes.js";
import { openBackend } from "./backend.js";

const RELAY_PORT = Number(Bun.env.RELAY_PORT ?? 5198);
const API_PORT = Number(Bun.env.API_PORT ?? 5199);
const DATA_DIR = Bun.env.DATA_DIR ?? ".syncmesh/example";

// the relay and the server peer, in this process — see backend.ts for each step
const backend = await openBackend({
  dataDir: DATA_DIR,
  relayPort: RELAY_PORT,
  ...omitUndefined({ relayUrl: Bun.env.RELAY_URL }),
  onGrant: (line) => console.log(line),
});

// your app, untouched: an ordinary SELECT over the table the fold writes
const api = Bun.serve({
  port: API_PORT,
  fetch: async () => Response.json(await backend.db.select().from(notes)),
});

console.log(
  `relay   ${backend.dialing}${backend.relay === undefined ? "  (not ours: RELAY_URL is set)" : ""}`,
);
console.log(`api     http://localhost:${API_PORT}/  (GET: the notes table, straight from SQLite)`);
console.log(`issuer  ${backend.issuer}`);
console.log(`invite  ${INVITE}`);
console.log(`\nrun a device:  bun run device alice "first note"`);

const stop = async (): Promise<void> => {
  await api.stop(true);
  await backend.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

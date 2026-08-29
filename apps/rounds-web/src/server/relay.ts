import { startRelay } from "@syncmesh/relay";

/**
 * The relay the ward's phones and this station both dial — `bun run relay`.
 *
 * Its room log is its own SQLite: a relay is a peer that keeps a copy, not a message bus.
 */
const port = Number(Bun.env.PORT ?? 5198);
await startRelay(port, { dataDir: ".syncmesh/relay" });
console.log(`relay on ws://localhost:${String(port)}/rounds`);

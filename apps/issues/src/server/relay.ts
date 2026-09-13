import { startRelay } from "@syncmesh/relay";

/**
 * The relay two installs of this tracker meet on — `bun run --cwd apps/issues relay`.
 *
 * **A second process beside the dev server, started by hand, and that is the point.** Folding it
 * into `vp dev` would make convergence something the app appears to have rather than something it
 * is given, and the first question anybody asks of a local-first demo is what happens when the
 * server is not there. Two terminals answers it: stop this one and the app keeps working, says
 * `Relay unreachable`, and picks up where it left off when it comes back.
 *
 * It is not a server in the sense the app has none of: its room log is its own SQLite file, it
 * holds no issuer key, it verifies signatures and judges nothing (see `createGrantCache`), and
 * every device on it holds the whole room. A relay is a peer that keeps a copy and is always on.
 */
const port = Number(Bun.env["PORT"] ?? 5241);

const relay = await startRelay(port, { dataDir: ".syncmesh/relay" });

console.log(
  `relay on ${relay.url}/issues — the app dials this unless VITE_RELAY_URL says otherwise`,
);

const stop = async (): Promise<void> => {
  await relay.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

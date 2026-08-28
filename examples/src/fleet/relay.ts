import { redisFanout, startRelay } from "@syncmesh/relay";

import { redisPubSub } from "./redis.js";

const port = Number(Bun.env.PORT ?? 5198);
const dataDir = Bun.env.DATA_DIR ?? ".syncmesh/relay";
const name = Bun.env.INSTANCE_NAME ?? `relay:${port}`;
const url = Bun.env.REDIS_URL ?? "redis://localhost:6379";

// One instance of the fleet. Its room log is its own — a volume per container, never shared —
// and Redis is a transport between instances, not the relay's storage.
const redis = await redisPubSub(url);
const relay = await startRelay(port, { dataDir, fanout: redisFanout(redis) });

console.log(`${name} serving ${relay.url}, fanning out over ${url}`);

const stop = async (): Promise<void> => {
  await relay.stop();
  await redis.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

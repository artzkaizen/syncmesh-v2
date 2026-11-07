import { library } from "@syncmesh/config/vite";

// the served-read suites read their server (wal_level = logical) from here, as @syncmesh/postgres does
export default library({
  entries: ["src/internal.ts"],
  testEnv: ["SYNCMESH_PG_REPLICATION_URL"],
});

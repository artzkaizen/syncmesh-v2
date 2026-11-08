import { library } from "@syncmesh/config/vite";

// the logical-replication suite reads its server (wal_level = logical) from the first, and the
// store contract runs against a real server when the second is set
export default library({ testEnv: ["SYNCMESH_PG_REPLICATION_URL", "SYNCMESH_PG_URL"] });

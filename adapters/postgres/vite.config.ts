import { library } from "@syncmesh/config/vite";

// the logical-replication suite reads its server (wal_level = logical) from here
export default library({ testEnv: ["SYNCMESH_PG_REPLICATION_URL"] });

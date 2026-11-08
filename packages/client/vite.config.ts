import { library } from "@syncmesh/config/vite";

// `@syncmesh/client/internal`: `createMesh`, for the layers under an app (D47)
export default library({ entries: ["src/harness.ts"] });

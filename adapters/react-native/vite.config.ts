import { library } from "@syncmesh/config/vite";

// `library` rather than `adapter`, for its `neutral` platform: Hermes is neither Node nor a
// browser, and resolving under either one's conditions would pick the wrong half of a package.
export default library({
  entries: [
    "src/dev-server.ts",
    "src/network.ts",
    "src/crypto.ts",
    "src/entropy.ts",
    "src/ble.ts",
    "src/p2p.ts",
    "src/lan.ts",
  ],
});

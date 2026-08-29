import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackStart()],
  // the mesh runs in the server bundle only; these must never be pulled into the browser graph
  ssr: { noExternal: ["@syncmesh/examples"] },
});

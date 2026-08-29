import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackStart(),
    // Start's dev mode needs the React Refresh runtime, and refuses to serve the client entry
    // without it — a 500 on that one module, which leaves the SSR html on screen with no
    // JavaScript attached to it. The page looks right and nothing is interactive.
    viteReact(),
  ],
  // the mesh runs in the server bundle only; this must never be pulled into the browser graph
  ssr: { noExternal: ["@syncmesh/examples"] },
});

import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackStart({
      /**
       * Forced on. The plugin otherwise installs its SSR middleware only when it recognises the
       * server environment, and in this monorepo it does not — so `vite dev` served a bare 404
       * while `vite build` was fine. The middleware is exactly what dev needs; the guard is the
       * detection, not the requirement.
       */
      vite: { installDevServerMiddleware: true },
    }),
  ],
  // the mesh runs in the server bundle only; these must never be pulled into the browser graph
  ssr: { noExternal: ["@syncmesh/examples"] },
});
